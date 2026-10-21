"use client";
import type { ComponentProps, ReactNode } from "react";
import { PopoverTrigger } from "./Popover.js";
import { TeamAvatar } from "./TeamAvatar.js";
import { UserAvatar } from "./UserAvatar.js";
export type IdentityPickerLabels = { searchPlaceholder: string; empty: string; addAnotherAccount: string; switchAccountAria: string; switcherAriaLabel: string };
export type IdentityAccount = { id: string; name: string; email: string; avatarUrl?: string };
export type IdentityWorkspace = { id: string; name: string; iconSeed?: number | null; iconUrl?: string | null; pickerPinnedAt?: string | null; pickerHiddenAt?: string | null; pickerLastOpenedAt?: string | null };
const cn = (...parts: Array<string | false | undefined>) => parts.filter(Boolean).join(" ");
function IdentityAccountRow({
  account,
  isActive,
  switching,
  onSwitch,
  switchLabel,
}: {
  account: IdentityAccount;
  isActive: boolean;
  switching: boolean;
  onSwitch: () => void;
  switchLabel: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={isActive ? undefined : onSwitch}
      disabled={isActive || switching}
      aria-current={isActive ? "true" : undefined}
      aria-label={
        isActive
          ? undefined
          : switchLabel
      }
      className={cn(
        "w-full inline-flex items-center gap-2 rounded px-2 py-1.5 text-left transition-colors min-w-0 min-h-11 sm:min-h-0",
        isActive ? "bg-muted/60 cursor-default" : "hover:bg-muted cursor-pointer",
      )}
    >
      <UserAvatar
        size={24}
        name={account.name}
        email={account.email}
        avatarUrl={account.avatarUrl}
      />
      <span className="flex-1 truncate text-xs text-muted-foreground">
        {account.email || account.name}
      </span>
      {switching ? (
        <Spinner />
      ) : isActive ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden className="shrink-0 text-primary">
          <path d="M5 12l5 5L20 7" />
        </svg>
      ) : null}
    </button>
  );
}

function Spinner() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      className="shrink-0 animate-spin text-muted-foreground"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" fill="none" opacity="0.25" />
      <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function IdentityWorkspaceRow({
  workspace,
  isActive,
  onSelect,
}: {
  workspace: IdentityWorkspace;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={cn(
        "w-full inline-flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors text-left min-h-11 sm:min-h-0",
        isActive ? "bg-muted" : "hover:bg-muted",
      )}
      aria-current={isActive ? "true" : undefined}
    >
      <TeamAvatar
        id={workspace.id}
        name={workspace.name}
        iconSeed={workspace.iconSeed}
        iconUrl={workspace.iconUrl}
        size="sm"
      />
      <span className="flex-1 truncate">{workspace.name}</span>
      {isActive && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden className="text-primary">
          <path d="M5 12l5 5L20 7" />
        </svg>
      )}
    </button>
  );
}


export function WorkspacePickerTrigger({ workspace, open, iconOnly = false, label, ...props }: Omit<ComponentProps<typeof PopoverTrigger>, 'children'> & { workspace: IdentityWorkspace; open: boolean; iconOnly?: boolean; label: string }) {
  return <PopoverTrigger {...props} data-workspace-switcher-trigger data-workspace-icon={iconOnly || undefined} aria-label={label}
    className={state => cn("inline-flex shrink-0 items-center transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40", iconOnly ? "size-11 justify-center rounded-xl" : "min-h-11 min-w-0 max-w-full gap-1.5 rounded-md px-1.5 py-1 text-sm sm:min-h-0", typeof props.className === "function" ? props.className(state) : props.className)}>
    <span aria-hidden><TeamAvatar {...workspace} size={iconOnly ? "sm" : "xs"} /></span>
    {!iconOnly && <><span className="min-w-0 max-w-[140px] truncate text-[13px] font-semibold">{workspace.name}</span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden className={cn("shrink-0 text-muted-foreground/60 transition-transform", open && "rotate-180")}><path d="M6 9l6 6 6-6" /></svg></>}
  </PopoverTrigger>;
}
export function IdentityAccountSection({ accounts, activeId, switchingId, onSwitch, switchLabel, error, isActiveAccount }: {
  accounts: IdentityAccount[]; activeId?: string | null; switchingId?: string | null; onSwitch: (id: string) => void; switchLabel: (account: IdentityAccount) => string; error?: ReactNode; isActiveAccount?: (account: IdentityAccount) => boolean;
}) {
  return <div className="flex shrink-0 flex-col gap-0.5">{accounts.map(account => <IdentityAccountRow key={account.id || account.email} account={account} isActive={isActiveAccount ? isActiveAccount(account) : account.id === activeId} switching={switchingId === account.id} onSwitch={() => onSwitch(account.id)} switchLabel={switchLabel(account)} />)}{error && <div className="px-2 pt-1 text-[12px] text-destructive">{error}</div>}</div>;
}
export function IdentityWorkspaceSection({ workspaces, activeId, onSelect, searchable, query, onQueryChange, searchLabel, emptyLabel, children }: {
  workspaces: IdentityWorkspace[]; activeId?: string | null; onSelect: (id: string) => void; searchable: boolean; query: string; onQueryChange: (value: string) => void; searchLabel: string; emptyLabel: string; children?: ReactNode;
}) {
  return <>{searchable ? <label className="relative block shrink-0"><span className="sr-only">{searchLabel}</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg><input type="search" value={query} onChange={event => onQueryChange(event.target.value)} placeholder={searchLabel} className="h-11 w-full rounded-md border border-border bg-background pl-8 pr-2 text-[16px] outline-none placeholder:text-muted-foreground sm:h-8 md:text-xs" /></label> : null}
    <ul className={cn("flex shrink-0 flex-col gap-0.5", searchable && "max-h-60 overflow-y-auto pr-1")}>{workspaces.map(workspace => <li key={workspace.id}><IdentityWorkspaceRow workspace={workspace} isActive={workspace.id === activeId} onSelect={() => onSelect(workspace.id)} /></li>)}{searchable && workspaces.length === 0 ? <li className="px-2 py-3 text-xs text-muted-foreground">{emptyLabel}</li> : null}{children}</ul>
  </>;
}
export function IdentityMenuAction({ children, ...props }: ComponentProps<'button'>) {
  return <button type="button" role="menuitem" {...props} className={cn("min-h-11 text-left px-2 py-1.5 text-sm hover:bg-muted rounded transition-colors sm:min-h-0", props.className)}>{children}</button>;
}
