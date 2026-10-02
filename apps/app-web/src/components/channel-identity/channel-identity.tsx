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
 * Spec: docs/plans/channel-identity-binding.md §4.
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
  getChannelIdentities,
  listLinkedAccounts,
  unlinkAccount,
  type ChannelEmailMatch,
  type ChannelEmailMatching,
  type ChannelLinkCode,
  type LinkedAccount,
} from "@/lib/api/account";
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

function RowSkeleton() {
  return <div aria-hidden className="h-10 rounded-lg bg-muted/40 animate-pulse" />;
}

// ── Data ─────────────────────────────────────────────────────────────

type IdentityData = {
  linked: LinkedAccount[];
  emailMatches: ChannelEmailMatch[];
  emailMatching: ChannelEmailMatching[];
  emailMatchingVisible: boolean;
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
      {connectable.map((kind) => (
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
  channel: { id: string; channelType: string; integrationProvider?: string | null };
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
      {data ? (
        <ChannelIdentityRow descriptor={descriptor} {...rowInputs(data, descriptor)} onChanged={reload} hideLabel />
      ) : (
        <RowSkeleton />
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
