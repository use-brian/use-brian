"use client";

/**
 * Slack app manifest used by workspace Studio Channels.
 * Retains the existing module path for the Channels import.
 *
 * [COMP:app-web/slack-setup-inline]
 */

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
