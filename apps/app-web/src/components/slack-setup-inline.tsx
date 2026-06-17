"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth-fetch";
import { getIconColor } from "@/components/assistant-avatar";
import { useT } from "@/lib/i18n/client";
import { DISPLAY_API_URL } from "@/lib/display-api-url";

/**
 * Inline Slack BYO setup wizard — renders inside the assistant detail page
 * instead of navigating to a separate page.
 *
 * Ported from `apps/web/src/components/slack-setup-inline.tsx` for the app
 * consolidation (docs/plans/doc-web-app-consolidation.md §9 #5, CHUNK 4).
 * `buildManifest` is the load-bearing export here: Studio → Channels imports
 * it to pre-generate a Slack app manifest for the "+ Add channel" flow.
 *
 * Three sections:
 *   1. Copy the pre-generated app manifest
 *   2. Paste credentials (bot token + signing secret)
 *   3. Connect
 *
 * [COMP:app-web/slack-setup-inline]
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export function SlackSetupInline({
  assistantId,
  assistantName,
  iconSeed,
  onClose,
  onConnected,
}: {
  assistantId: string;
  assistantName?: string;
  iconSeed?: number;
  onClose: () => void;
  onConnected: () => void;
}) {
  const t = useT();
  // Embedded in the Slack app manifest the user copies into Slack — must be
  // the absolute API origin, never the dev-blanked fetch base.
  const webhookUrl = `${DISPLAY_API_URL}/webhook/slack/${assistantId}`;

  const [botToken, setBotToken] = useState("");
  const [signingSecret, setSigningSecret] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

  const [manifestCopied, setManifestCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  // Manifest customization — pure UI state, not persisted
  const defaultSeed = iconSeed ?? Array.from(assistantId).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
  const [appName, setAppName] = useState(assistantName || "My AI Assistant");
  const [appDescription, setAppDescription] = useState("Personal AI assistant powered by sidanclaw");
  const [bgColor, setBgColor] = useState(() => getIconColor(defaultSeed));

  const canSubmit =
    botToken.startsWith("xoxb-") && signingSecret.length >= 16 && !submitting;

  const manifest = buildManifest(webhookUrl, { appName, appDescription, bgColor });

  function copyManifest() {
    navigator.clipboard.writeText(manifest).then(() => {
      setManifestCopied(true);
      setTimeout(() => setManifestCopied(false), 2000);
    });
  }

  async function handleConnect() {
    setSubmitting(true);
    setError(null);

    try {
      const res = await authFetch(
        `${API_URL}/api/assistants/${assistantId}/integrations/slack`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ botToken, signingSecret }),
        },
      );

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
          detail?: string;
        } | null;
        setError(
          data?.detail ?? data?.error ?? `Failed to connect (${res.status})`,
        );
        return;
      }

      setConnected(true);
      onConnected();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4 pt-2">
      {/* Header with close */}
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-[15px] font-semibold tracking-tight">{t.setup.slack.header}</h3>
          <p className="text-[12px] text-muted-foreground mt-1 leading-relaxed">
            {t.setup.slack.desc}
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground transition-colors p-1"
        >
          <CloseIcon />
        </button>
      </div>

      {/* Step 1: Copy manifest */}
      <StepCard number={1} title={t.setup.slack.step1}>
        <p className="text-[12px] text-muted-foreground leading-relaxed">
          {t.setup.slack.step1Desc}
        </p>

        {/* Manifest customization */}
        <div className="space-y-2.5 mb-3">
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-[11px] font-medium text-muted-foreground block mb-1">{t.setup.slack.appName}</label>
              <input
                type="text"
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                maxLength={35}
                className="w-full bg-muted/50 border border-border rounded-md px-2.5 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium text-muted-foreground block mb-1">{t.setup.slack.color}</label>
              <div className="flex items-center gap-1.5">
                <input
                  type="color"
                  value={bgColor}
                  onChange={(e) => setBgColor(e.target.value)}
                  className="w-8 h-8 rounded border border-border cursor-pointer p-0"
                />
                <input
                  type="text"
                  value={bgColor}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (/^#[0-9A-Fa-f]{0,6}$/.test(v)) setBgColor(v);
                  }}
                  maxLength={7}
                  className="w-20 bg-muted/50 border border-border rounded-md px-2 py-1.5 text-[13px] text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>
          </div>
          <div>
            <label className="text-[11px] font-medium text-muted-foreground block mb-1">{t.setup.slack.description}</label>
            <input
              type="text"
              value={appDescription}
              onChange={(e) => setAppDescription(e.target.value)}
              maxLength={140}
              className="w-full bg-muted/50 border border-border rounded-md px-2.5 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>

        <div className="relative">
          <pre className="text-[11px] font-mono leading-relaxed px-3 py-2.5 rounded-lg bg-muted text-foreground overflow-x-auto max-h-48 overflow-y-auto border border-border">
            {manifest}
          </pre>
          <div className="absolute top-1.5 right-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={copyManifest}
              className="text-[11px] h-6 px-2"
            >
              {manifestCopied ? t.setup.slack.copied : t.setup.slack.copy}
            </Button>
          </div>
        </div>
      </StepCard>

      {/* Step 2: Paste credentials */}
      <StepCard number={2} title={t.setup.slack.step2}>
        <div className="space-y-3">
          <Field
            label={t.setup.slack.botToken}
            hint={t.setup.slack.botTokenHint}
          >
            <SecretInput
              value={botToken}
              onChange={setBotToken}
              placeholder="xoxb-..."
              visible={showToken}
              onToggle={() => setShowToken((v) => !v)}
              disabled={connected}
            />
          </Field>

          <Field
            label={t.setup.slack.signingSecret}
            hint={t.setup.slack.signingSecretHint}
          >
            <SecretInput
              value={signingSecret}
              onChange={setSigningSecret}
              placeholder="••••••••••••••••"
              visible={showSecret}
              onToggle={() => setShowSecret((v) => !v)}
              disabled={connected}
            />
          </Field>
        </div>
      </StepCard>

      {/* Step 3: Connect */}
      <StepCard number={3} title={t.setup.slack.step3}>
        {connected ? (
          <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-3">
            <div className="text-[12px] font-medium text-green-400">
              {t.setup.slack.connected}
            </div>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {t.setup.slack.verifyDm}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {error && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-2.5">
                <p className="text-[11px] text-red-400">{error}</p>
              </div>
            )}
            <div className="flex items-center gap-3">
              <Button
                disabled={!canSubmit}
                onClick={handleConnect}
                size="sm"
                className="gap-2"
              >
                {submitting ? t.setup.slack.connecting : t.setup.slack.connect}
              </Button>
              {!canSubmit && botToken.length > 0 && !submitting && (
                <span className="text-[11px] text-muted-foreground">
                  {t.setup.slack.validation}
                </span>
              )}
            </div>
          </div>
        )}
      </StepCard>
    </div>
  );
}

// ─── Manifest generator ────────────────────────────────────────

export function buildManifest(webhookUrl: string, opts: {
  appName: string;
  appDescription: string;
  bgColor: string;
}): string {
  const { appName, appDescription, bgColor } = opts;
  // Slack display_name: lowercase, no spaces, max 80 chars
  const displayName = appName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 80) || "my-assistant";

  return `_metadata:
  major_version: 2
  minor_version: 1

display_information:
  name: ${appName}
  description: ${appDescription}
  background_color: "${bgColor}"

features:
  assistant_view:
    assistant_description: ${appDescription}
    suggested_prompts: []
  bot_user:
    display_name: ${displayName}
    always_online: true
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false

oauth_config:
  scopes:
    bot:
      - chat:write
      - channels:history
      - groups:history
      - im:history
      - channels:read
      - groups:read
      - im:read
      - users:read
      - users:read.email
      - files:read
      - reactions:write
      - app_mentions:read
      - assistant:write

settings:
  event_subscriptions:
    request_url: "${webhookUrl}"
    bot_events:
      - assistant_thread_started
      - assistant_thread_context_changed
      - message.channels
      - message.groups
      - message.im
      - app_mention
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false`;
}

// ─── Building blocks ───────────────────────────────────────────

function StepCard({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
      <div className="flex items-center gap-2.5">
        <div className="w-6 h-6 rounded-full bg-primary/15 text-primary text-[11px] font-semibold flex items-center justify-center shrink-0">
          {number}
        </div>
        <h4 className="text-[13px] font-semibold tracking-tight text-foreground">
          {title}
        </h4>
      </div>
      <div className="space-y-2.5 pl-8.5">{children}</div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-[11px] font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SecretInput({
  value,
  onChange,
  placeholder,
  visible,
  onToggle,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  visible: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="flex items-stretch gap-1.5">
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="flex-1 min-w-0 text-[12px] font-mono px-2.5 py-1.5 rounded-lg bg-background border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary transition-colors disabled:opacity-50"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onToggle}
        className="shrink-0 h-auto text-[11px] px-2"
        disabled={disabled}
      >
        {visible ? t.setup.slack.hide : t.setup.slack.show}
      </Button>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}
