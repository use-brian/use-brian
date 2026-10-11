"use client";

/**
 * Channel identity - one connect surface for every chat channel.
 *
 * `ChannelIdentityRow` is the single row behind both entry points:
 * - Settings -> Account -> Connected accounts (`ConnectedAccountsList`)
 * - the footer card on every Studio channel (`ChannelIdentityFooter`)
 *
 * Which channels can connect, how, and whether they match by email comes
 * from `CHANNEL_IDENTITY` (@use-brian/shared), whose parity with the channel
 * routes is test-enforced - so a row never offers Connect on a channel whose
 * route would ignore the link. States: loading, connected (by code), matched
 * by email, not connected, connecting (code + countdown), unavailable.
 *
 * WeChat is channel-scoped (`scope: 'channel'`): one row per bot the person
 * paired or was given, minted with `{ workspaceId, channelId }` and read from
 * the canonical bindings - `WechatChannelIdentityRow`. States: linked as me,
 * not linked, linked elsewhere (no other account named), access removed,
 * paired again, disconnected, conflict.
 *
 * Spec: docs/plans/channel-identity-binding.md §4;
 * docs/architecture/channels/wechat.md → "Staff identity".
 * Component tag: [COMP:app-web/channel-identity].
 */

import { useCallback, useEffect, useState } from "react";
import {
  CHANNEL_IDENTITY,
  CHANNEL_IDENTITY_KINDS,
  channelIdentityFor,
  type ChannelIdentityDescriptor,
  type ChannelIdentityKind,
} from "@use-brian/shared";
import {
  createChannelLinkCode,
  createWechatLinkCode,
  getChannelIdentities,
  listLinkedAccounts,
  revokeWechatBinding,
  unlinkAccount,
  type ChannelEmailMatch,
  type ChannelEmailMatching,
  type ChannelLinkCode,
  type LinkedAccount,
  type WechatBinding,
  type WechatChannelSummary,
} from "@/lib/api/account";
import {
  getWechatTransportStatus,
  revokeWechatChannelBinding,
  wechatPreparedLink,
  type WechatTransportStatus,
} from "@/lib/api/channels";
import { buildTelegramDeepLink, formatCountdown, linkCodeSecondsLeft } from "@/lib/telegram-link";
import { buildWhatsappDeepLink } from "@/lib/whatsapp-link";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

type Notice = { kind: "success" | "error"; text: string } | null;

export type ChannelIdentityRowProps = {
  descriptor: ChannelIdentityDescriptor;
  /** Explicit link for this channel's provider, if any. */
  linked: LinkedAccount | null;
  /** Email-based match for this channel's provider, if any. */
  emailMatch: ChannelEmailMatch | null;
  /** Called after connect / disconnect so the parent can reload. */
  onChanged?: () => void;
  /** Hide the channel label (the footer card already names the channel). */
  hideLabel?: boolean;
  /** Start in the connecting state with this code (tests / SSR). */
  initialCode?: ChannelLinkCode | null;
};

function linkedDisplayName(account: LinkedAccount): string {
  const meta = account.providerMetadata ?? {};
  for (const key of ["displayName", "firstName", "username", "name"]) {
    const value = meta[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return account.providerId;
}

export function ChannelIdentityRow({
  descriptor,
  linked,
  emailMatch,
  onChanged,
  hideLabel,
  initialCode,
}: ChannelIdentityRowProps) {
  const t = useT();
  const copy = t.settings.account.channelIdentity;
  const label = copy.labels[descriptor.kind];
  const [code, setCode] = useState<ChannelLinkCode | null>(initialCode ?? null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [secondsLeft, setSecondsLeft] = useState(() =>
    initialCode ? linkCodeSecondsLeft(initialCode.expiresAt) : 0,
  );

  // Countdown + poll for the claim while a code is live.
  useEffect(() => {
    if (!code) return;
    const expiresAt = code.expiresAt;
    setSecondsLeft(linkCodeSecondsLeft(expiresAt));
    const tick = setInterval(() => setSecondsLeft(linkCodeSecondsLeft(expiresAt)), 1000);
    const poll = setInterval(() => {
      if (linkCodeSecondsLeft(expiresAt) <= 0) return;
      void listLinkedAccounts().then((accounts) => {
        if (accounts.some((a) => a.provider === descriptor.linkProvider)) {
          setCode(null);
          setNotice({ kind: "success", text: format(copy.linked, { channel: label }) });
          onChanged?.();
        }
      });
    }, 3000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [code, descriptor.linkProvider, copy.linked, label, onChanged]);

  async function onConnect() {
    if (!descriptor.codeEndpoint) return;
    setBusy(true);
    setNotice(null);
    try {
      const minted = await createChannelLinkCode(descriptor.codeEndpoint);
      if (!minted) {
        setNotice({ kind: "error", text: copy.notOnInstallation });
        return;
      }
      setCode(minted);
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnect() {
    if (!linked) return;
    const ok = await confirmDialog({
      title: format(copy.disconnectTitle, { channel: label }),
      description: format(
        descriptor.emailMatching ? copy.disconnectConfirmEmail : copy.disconnectConfirm,
        { channel: label },
      ),
      confirmLabel: copy.disconnect,
      cancelLabel: copy.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    setNotice(null);
    try {
      if (!(await unlinkAccount(linked.id))) {
        setNotice({ kind: "error", text: copy.error });
        return;
      }
      setNotice({ kind: "success", text: format(copy.unlinked, { channel: label }) });
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  const unavailable = descriptor.connect === "unavailable";
  const expired = code !== null && secondsLeft <= 0;
  const deepLink = !code
    ? null
    : descriptor.kind === "telegram"
      ? buildTelegramDeepLink(code.botUsername, code.code)
      : descriptor.kind === "whatsapp"
        ? buildWhatsappDeepLink(code.officialNumber, code.code)
        : null;

  let status: string;
  let hint: string | null = null;
  if (linked) {
    status = format(copy.connectedAs, { name: linkedDisplayName(linked) });
  } else if (emailMatch) {
    status = format(copy.matchedByEmail, { name: emailMatch.displayName ?? emailMatch.providerId });
    hint = copy.matchedByEmailHint;
  } else if (unavailable) {
    status = copy.unavailable;
    hint = copy.unavailableHint;
  } else {
    status = copy.notConnected;
    hint = descriptor.emailMatching ? `${copy.notConnectedHint} ${copy.emailAutoHint}` : copy.notConnectedHint;
  }

  const howTo =
    descriptor.kind === "whatsapp"
      ? format(copy.howTo.whatsapp, { number: code?.officialNumber ?? "" })
      : descriptor.kind === "telegram" || descriptor.kind === "slack" || descriptor.kind === "feishu"
        ? copy.howTo[descriptor.kind]
        : null;

  return (
    <div className="space-y-3" data-channel-identity={descriptor.kind}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          {!hideLabel && <div className="text-sm font-medium">{label}</div>}
          <div className="text-xs text-muted-foreground">{status}</div>
          {hint && !code && <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div>}
        </div>
        {linked ? (
          <button
            type="button"
            onClick={() => void onDisconnect()}
            disabled={busy}
            className="shrink-0 min-h-11 md:min-h-0 text-sm font-medium border border-border px-4 py-2 rounded-lg hover:bg-muted transition-colors disabled:opacity-50"
          >
            {busy ? "…" : copy.disconnect}
          </button>
        ) : !unavailable && !code ? (
          <button
            type="button"
            onClick={() => void onConnect()}
            disabled={busy}
            className="shrink-0 min-h-11 md:min-h-0 text-sm font-medium px-4 py-2 rounded-lg bg-action text-action-foreground hover:bg-action/90 disabled:opacity-50"
          >
            {busy ? "…" : copy.connect}
          </button>
        ) : null}
      </div>

      {code && (
        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
          <div className="text-2xl font-mono tracking-[0.3em] text-center select-all">{code.code}</div>
          {howTo && <p className="text-[12px] text-muted-foreground">{howTo}</p>}
          <p className="text-[11px] text-muted-foreground">{copy.movesHere}</p>
          <div className="flex flex-wrap items-center gap-3">
            {deepLink && !expired && (
              <a
                href={deepLink}
                target="_blank"
                rel="noreferrer"
                className="min-h-11 md:min-h-0 inline-flex items-center text-sm font-medium px-4 py-2 rounded-lg bg-action text-action-foreground hover:bg-action/90"
              >
                {descriptor.kind === "telegram" ? copy.openTelegram : copy.openWhatsapp}
              </a>
            )}
            {expired && (
              <button
                type="button"
                onClick={() => void onConnect()}
                disabled={busy}
                className="min-h-11 md:min-h-0 inline-flex items-center text-sm font-medium px-4 py-2 rounded-lg bg-action text-action-foreground hover:bg-action/90 disabled:opacity-50"
              >
                {busy ? "…" : copy.generateNewCode}
              </button>
            )}
            <button
              type="button"
              onClick={() => setCode(null)}
              className="min-h-11 md:min-h-0 text-sm text-muted-foreground hover:text-foreground"
            >
              {copy.cancel}
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {expired ? copy.codeExpired : format(copy.codeExpiresIn, { time: formatCountdown(secondsLeft) })}
          </p>
        </div>
      )}

      {notice && (
        <p className={notice.kind === "success" ? "text-[12px] text-primary" : "text-[12px] text-red-400"}>
          {notice.text}
        </p>
      )}
    </div>
  );
}

// ── WeChat: one row per channel ──────────────────────────────────────

type WechatRowState =
  | "linked" | "not_linked" | "linked_elsewhere" | "access_removed"
  | "pairing_replaced" | "revoked" | "conflict" | "not_available";

/**
 * The caller on ONE WeChat channel. Linking mints a code scoped to this
 * workspace and channel; the person sends `LINK <code>` from the WeChat
 * account that paired the bot, and the row polls until the binding appears.
 * Never shows which other account holds a channel.
 */
export function WechatChannelIdentityRow({
  workspaceId,
  channelId,
  channelName,
  binding,
  onChanged,
  hideLabel,
  pollMs = 3000,
}: {
  workspaceId: string;
  channelId: string;
  channelName: string | null;
  binding: WechatBinding | null;
  onChanged?: () => void;
  hideLabel?: boolean;
  /** Test seam. */
  pollMs?: number;
}) {
  const t = useT();
  const copy = t.settings.account.channelIdentity;
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [refused, setRefused] = useState<WechatRowState | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (!code) return;
    const expiresAt = code.expiresAt;
    setSecondsLeft(linkCodeSecondsLeft(expiresAt));
    const tick = setInterval(() => setSecondsLeft(linkCodeSecondsLeft(expiresAt)), 1000);
    const poll = setInterval(() => {
      if (linkCodeSecondsLeft(expiresAt) <= 0) return;
      void getChannelIdentities(workspaceId).then((data) => {
        if (data.wechatBindings.some((b) => b.channelId === channelId && b.state === "linked")) {
          setCode(null);
          setNotice({ kind: "success", text: copy.wechatLinkedNotice });
          onChanged?.();
        }
      });
    }, pollMs);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [code, workspaceId, channelId, copy.wechatLinkedNotice, onChanged, pollMs]);

  async function onLink() {
    setBusy(true);
    setNotice(null);
    setRefused(null);
    try {
      const minted = await createWechatLinkCode(workspaceId, channelId);
      if (minted.ok) {
        setCode({ code: minted.code, expiresAt: minted.expiresAt });
        return;
      }
      if (minted.reason === "linked_elsewhere") setRefused("linked_elsewhere");
      else if (minted.reason === "conflict") setRefused("conflict");
      else if (minted.reason === "not_found") setRefused("not_available");
      else setNotice({
        kind: "error",
        text: minted.reason === "rate_limited" ? copy.wechatRateLimited
          : minted.reason === "unavailable" ? copy.notOnInstallation
            : copy.error,
      });
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnect() {
    if (!binding) return;
    const ok = await confirmDialog({
      title: format(copy.disconnectTitle, { channel: channelName ?? copy.labels.wechat }),
      description: copy.wechatDisconnectConfirm,
      confirmLabel: copy.disconnect,
      cancelLabel: copy.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    setNotice(null);
    try {
      if (!(await revokeWechatBinding(binding.bindingId))) {
        setNotice({ kind: "error", text: copy.error });
        return;
      }
      setNotice({ kind: "success", text: format(copy.unlinked, { channel: channelName ?? copy.labels.wechat }) });
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  const state: WechatRowState = refused
    ?? (binding?.state === "linked" ? "linked"
      : binding?.state === "access_removed" ? "access_removed"
        : binding?.state === "pairing_replaced" ? "pairing_replaced"
          : binding?.state === "revoked" ? "revoked"
            : "not_linked");
  const status = {
    linked: copy.wechatLinked,
    not_linked: copy.wechatNotLinked,
    linked_elsewhere: copy.wechatLinkedElsewhere,
    access_removed: copy.wechatAccessRemoved,
    pairing_replaced: copy.wechatPairingReplaced,
    revoked: copy.wechatRevoked,
    conflict: copy.wechatConflict,
    not_available: copy.wechatNotAvailable,
  }[state];
  const hint = {
    linked: null,
    not_linked: copy.wechatNotLinkedHint,
    linked_elsewhere: copy.wechatLinkedElsewhereHint,
    access_removed: copy.wechatAccessRemovedHint,
    pairing_replaced: copy.wechatPairingReplacedHint,
    revoked: copy.wechatNotLinkedHint,
    conflict: copy.wechatConflictHint,
    not_available: null,
  }[state];
  const canLink = state === "not_linked" || state === "pairing_replaced" || state === "revoked";
  const expired = code !== null && secondsLeft <= 0;

  return (
    <div className="space-y-3" data-channel-identity="wechat" data-wechat-channel={channelId} data-state={state}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          {!hideLabel && <div className="text-sm font-medium truncate">{channelName ?? copy.labels.wechat}</div>}
          <div className="text-xs text-muted-foreground">{status}</div>
          {hint && !code && <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div>}
        </div>
        {(state === "linked" || state === "access_removed") ? (
          <button
            type="button"
            onClick={() => void onDisconnect()}
            disabled={busy}
            className="shrink-0 min-h-11 md:min-h-0 text-sm font-medium border border-border px-4 py-2 rounded-lg hover:bg-muted transition-colors disabled:opacity-50"
          >
            {busy ? "…" : copy.disconnect}
          </button>
        ) : canLink && !code ? (
          <button
            type="button"
            onClick={() => void onLink()}
            disabled={busy}
            className="shrink-0 min-h-11 md:min-h-0 text-sm font-medium px-4 py-2 rounded-lg bg-action text-action-foreground hover:bg-action/90 disabled:opacity-50"
          >
            {busy ? "…" : state === "not_linked" ? copy.wechatLink : copy.wechatLinkAgain}
          </button>
        ) : null}
      </div>

      {code && (
        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
          <div className="text-2xl font-mono tracking-[0.3em] text-center select-all">{code.code}</div>
          <p className="text-[12px] text-muted-foreground">
            {format(copy.howTo.wechat, { command: `LINK ${code.code}` })}
          </p>
          <p className="text-[11px] text-muted-foreground">{copy.wechatNoHistoryMove}</p>
          <div className="flex flex-wrap items-center gap-3">
            {expired && (
              <button
                type="button"
                onClick={() => void onLink()}
                disabled={busy}
                className="min-h-11 md:min-h-0 inline-flex items-center text-sm font-medium px-4 py-2 rounded-lg bg-action text-action-foreground hover:bg-action/90 disabled:opacity-50"
              >
                {busy ? "…" : copy.generateNewCode}
              </button>
            )}
            <button
              type="button"
              onClick={() => setCode(null)}
              className="min-h-11 md:min-h-0 text-sm text-muted-foreground hover:text-foreground"
            >
              {copy.cancel}
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {expired ? copy.codeExpired : format(copy.codeExpiresIn, { time: formatCountdown(secondsLeft) })}
          </p>
        </div>
      )}

      {notice && (
        <p className={notice.kind === "success" ? "text-[12px] text-primary" : "text-[12px] text-red-400"}>
          {notice.text}
        </p>
      )}
    </div>
  );
}

/**
 * Owner/admin view of a WeChat channel's identity: linked / unlinked /
 * revoked / conflict, the staff link to share, and a revoke that assigns
 * nobody. Members never see another account's name - the server sends this
 * summary to owners and admins only.
 */
function WechatChannelAdminSummary({
  workspaceId,
  summary,
  onChanged,
}: {
  workspaceId: string;
  summary: WechatChannelSummary;
  onChanged?: () => void;
}) {
  const t = useT();
  const copy = t.studioPage.channels.wechat;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [transport, setTransport] = useState<WechatTransportStatus | null>(null);
  useEffect(() => {
    let live = true;
    void getWechatTransportStatus(workspaceId, summary.channelId).then((status) => {
      if (live) setTransport(status);
    });
    return () => {
      live = false;
    };
  }, [workspaceId, summary.channelId]);
  const state =
    summary.state === "linked"
      ? format(copy.stateLinked, { name: summary.account?.name ?? summary.account?.email ?? "" })
      : summary.state === "unlinked" ? copy.stateUnlinked
        : summary.state === "revoked" ? copy.stateRevoked
          : copy.stateConflict;

  async function onRevoke() {
    const ok = await confirmDialog({
      title: copy.revokeTitle,
      description: copy.revokeDesc,
      confirmLabel: copy.revokeBinding,
      cancelLabel: t.settings.account.channelIdentity.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const done = await revokeWechatChannelBinding(workspaceId, summary.channelId);
      setNotice(done ? copy.revoked : t.settings.account.channelIdentity.error);
      if (done) onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  const link = typeof window !== "undefined"
    ? wechatPreparedLink(window.location.origin, workspaceId, summary.channelId)
    : "";

  return (
    <div className="border-t border-border pt-3 space-y-2" data-testid="wechat-admin-summary">
      <div className="text-[12px] font-medium">{copy.identityTitle}</div>
      <p className="text-[12px] text-muted-foreground">{state}</p>
      {transport && (
        <p className="text-[12px] text-muted-foreground" data-testid="wechat-transport">
          {transport === "polling" ? copy.transportPolling
            : transport === "paused" ? copy.transportPaused
              : transport === "unavailable" ? copy.transportUnavailable
                : copy.transportNotRunning}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {summary.state !== "linked" && summary.state !== "conflict" && (
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(link).then(() => setCopied(true), () => {});
            }}
            className="min-h-11 md:min-h-0 rounded-md border border-border px-3 py-1.5 text-sm"
          >
            {copied ? t.studioPage.channels.add.wechat.linkCopied : copy.copyStaffLink}
          </button>
        )}
        {summary.state === "linked" && (
          <button
            type="button"
            onClick={() => void onRevoke()}
            disabled={busy}
            className="min-h-11 md:min-h-0 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            {busy ? "…" : copy.revokeBinding}
          </button>
        )}
      </div>
      {notice && <p className="text-[12px] text-muted-foreground">{notice}</p>}
    </div>
  );
}

function RowSkeleton() {
  return <div aria-hidden className="h-10 rounded-lg bg-muted/40 animate-pulse" />;
}

// ── Data ─────────────────────────────────────────────────────────────

type IdentityData = {
  linked: LinkedAccount[];
  emailMatches: ChannelEmailMatch[];
  emailMatching: ChannelEmailMatching[];
  emailMatchingVisible: boolean;
  wechatBindings: WechatBinding[];
  wechatChannels: WechatChannelSummary[];
};

function useChannelIdentityData(workspaceId: string | null, initial?: IdentityData) {
  const [data, setData] = useState<IdentityData | null>(initial ?? null);
  const reload = useCallback(() => {
    void Promise.all([listLinkedAccounts(), getChannelIdentities(workspaceId)]).then(
      ([linked, identities]) => setData({ linked, ...identities }),
    );
  }, [workspaceId]);
  useEffect(() => {
    if (initial) return;
    reload();
  }, [initial, reload]);
  return { data, reload };
}

function rowInputs(data: IdentityData, descriptor: ChannelIdentityDescriptor) {
  const provider = descriptor.linkProvider ?? descriptor.kind;
  return {
    linked: descriptor.linkProvider ? data.linked.find((a) => a.provider === descriptor.linkProvider) ?? null : null,
    emailMatch: data.emailMatches.find((m) => m.provider === provider) ?? null,
  };
}

// ── Settings -> Account -> Connected accounts ────────────────────────

/**
 * Every connectable channel as one row, then a single line naming the
 * channels where connecting is not available yet. `kinds` narrows the list
 * (the hosted-only WhatsApp official number is omitted on self-host).
 */
export function ConnectedAccountsList({
  kinds = CHANNEL_IDENTITY_KINDS,
  initialData,
}: {
  kinds?: readonly ChannelIdentityKind[];
  initialData?: IdentityData;
}) {
  const t = useT();
  const copy = t.settings.account.channelIdentity;
  const { data, reload } = useChannelIdentityData(null, initialData);
  const connectable = kinds.filter((k) => CHANNEL_IDENTITY[k].connect !== "unavailable");
  const later = kinds.filter((k) => CHANNEL_IDENTITY[k].connect === "unavailable");

  if (!data) return <RowSkeleton />;
  return (
    <div className="space-y-4">
      {connectable.map((kind) => CHANNEL_IDENTITY[kind].scope === "channel" ? (
        // Channel-scoped: my own connections, one row each, never one global link.
        <div key={kind} className="space-y-3" data-testid="wechat-connections">
          <div className="text-sm font-medium">{copy.labels[kind]}</div>
          {data.wechatBindings.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{copy.wechatNone}</p>
          ) : (
            data.wechatBindings.map((binding) => (
              <WechatChannelIdentityRow
                key={binding.bindingId}
                workspaceId={binding.workspaceId}
                channelId={binding.channelId}
                channelName={binding.channelName}
                binding={binding}
                onChanged={reload}
              />
            ))
          )}
        </div>
      ) : (
        <ChannelIdentityRow
          key={kind}
          descriptor={CHANNEL_IDENTITY[kind]}
          {...rowInputs(data, CHANNEL_IDENTITY[kind])}
          onChanged={reload}
        />
      ))}
      {later.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {format(copy.otherChannels, { channels: later.map((k) => copy.labels[k]).join(", ") })}
        </p>
      )}
    </div>
  );
}

// ── Studio -> Channels -> <channel> footer ───────────────────────────

/**
 * "You on this channel": the same row, scoped to one Studio channel, plus an
 * admin-only email-matching line (the server returns that status only to
 * workspace owners/admins) naming the permissions to grant when it is off.
 */
export function ChannelIdentityFooter({
  channel,
  workspaceId,
  initialData,
}: {
  channel: { id: string; channelType: string; integrationProvider?: string | null; displayName?: string | null };
  workspaceId: string;
  initialData?: IdentityData;
}) {
  const t = useT();
  const copy = t.settings.account.channelIdentity;
  const descriptor = channelIdentityFor(channel.channelType, channel.integrationProvider);
  const { data, reload } = useChannelIdentityData(workspaceId, initialData);
  const label = copy.labels[descriptor.kind];
  const matching = data?.emailMatching.find((m) => m.channelId === channel.id) ?? null;
  const showMatching = descriptor.emailStatusReported && data?.emailMatchingVisible === true;

  return (
    <section className="border-t border-border pt-3 space-y-3" data-testid="channel-identity-footer">
      <div>
        <h3 className="text-sm font-semibold">{copy.footerTitle}</h3>
        <p className="text-[12px] text-muted-foreground">{copy.footerDesc}</p>
      </div>
      {!data ? (
        <RowSkeleton />
      ) : descriptor.scope === "channel" ? (
        <WechatChannelIdentityRow
          workspaceId={workspaceId}
          channelId={channel.id}
          channelName={channel.displayName ?? null}
          binding={data.wechatBindings.find((b) => b.channelId === channel.id) ?? null}
          onChanged={reload}
          hideLabel
        />
      ) : (
        <ChannelIdentityRow descriptor={descriptor} {...rowInputs(data, descriptor)} onChanged={reload} hideLabel />
      )}
      {descriptor.scope === "channel" && data?.wechatChannels.some((c) => c.channelId === channel.id) && (
        <WechatChannelAdminSummary
          workspaceId={workspaceId}
          summary={data.wechatChannels.find((c) => c.channelId === channel.id)!}
          onChanged={reload}
        />
      )}
      {showMatching && (
        <div className="border-t border-border pt-3 space-y-1" data-testid="channel-email-matching">
          <div className="text-[12px] font-medium">{copy.emailMatchingTitle}</div>
          <p className="text-[12px] text-muted-foreground">
            {!matching
              ? copy.emailMatchingUnknown
              : matching.status === "on"
                ? format(copy.emailMatchingOn, { channel: label })
                : format(copy.emailMatchingOff, { channel: label })}
          </p>
          {matching?.status === "off" && matching.missingScopes.length > 0 && (
            <p className="text-[12px] text-muted-foreground">
              {copy.emailMatchingFix}
              <code className="block mt-1 font-mono text-[11px] break-all">{matching.missingScopes.join(", ")}</code>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
