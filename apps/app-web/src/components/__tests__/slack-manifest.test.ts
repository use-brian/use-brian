import { describe, expect, it } from "vitest";
import { buildManifest } from "../slack-setup-inline";

const options = {
  appName: "Example Helper",
  appDescription: "A fictional workspace assistant",
  bgColor: "#234567",
};
const webhookUrl = "https://api.example.com/webhook/slack/REPLACE-AFTER-CONNECT";

// Pin the exported manifest consumed by workspace Channels, including YAML
// indentation, ordering, and the absence of a final newline.
const expectedManifest = `_metadata:
  major_version: 2
  minor_version: 1

display_information:
  name: Example Helper
  description: A fictional workspace assistant
  background_color: "#234567"

features:
  assistant_view:
    assistant_description: A fictional workspace assistant
    suggested_prompts: []
  bot_user:
    display_name: example-helper
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
    request_url: "https://api.example.com/webhook/slack/REPLACE-AFTER-CONNECT"
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

describe("[COMP:app-web/slack-setup-inline] workspace Slack manifest", () => {
  it("preserves the complete copyable manifest bytes", () => {
    expect(buildManifest(webhookUrl, options)).toBe(expectedManifest);
  });

  it("retains ordered message, identity, file, reaction, and assistant scopes", () => {
    const manifest = buildManifest(webhookUrl, options);
    const scopes = manifest.split("    bot:\n")[1].split("\n\nsettings:")[0];
    expect(scopes.split("\n").map((line) => line.trim().slice(2))).toEqual([
      "chat:write",
      "channels:history",
      "groups:history",
      "im:history",
      "channels:read",
      "groups:read",
      "im:read",
      "users:read",
      "users:read.email",
      "files:read",
      "reactions:write",
      "app_mentions:read",
      "assistant:write",
    ]);
  });

  it("retains assistant thread and channel, group, direct-message, mention events", () => {
    const manifest = buildManifest(webhookUrl, options);
    const events = manifest.split("    bot_events:\n")[1]
      .split("\n  org_deploy_enabled:")[0];
    expect(events.split("\n").map((line) => line.trim().slice(2))).toEqual([
      "assistant_thread_started",
      "assistant_thread_context_changed",
      "message.channels",
      "message.groups",
      "message.im",
      "app_mention",
    ]);
  });

  it.each([
    ["Example Helper", "example-helper"],
    ["UPPER-case", "upper-case"],
    ["Helper...  / Team", "helper-team"],
    ["  Helper!  ", "-helper-"],
    ["", "my-assistant"],
    ["日本語", "-"],
    ["a".repeat(81), "a".repeat(80)],
    ["A".repeat(79) + " / More", "a".repeat(79) + "-"],
  ])("preserves the bot display name for %j", (appName, displayName) => {
    const manifest = buildManifest(webhookUrl, { ...options, appName });
    expect(manifest).toContain(`  name: ${appName}\n`);
    expect(manifest).toContain(`    display_name: ${displayName}\n`);
  });

  it.each([
    "https://api.example.com/webhook/slack/REPLACE-AFTER-CONNECT",
    "https://self-host.example/webhook/slack/channel-example",
    "http://localhost:4000/webhook/slack/channel-example",
  ])("preserves the caller-supplied webhook URL %s", (url) => {
    const manifest = buildManifest(url, options);
    expect(manifest).toBe(expectedManifest.replace(webhookUrl, url));
  });

  it("keeps customization in display information and assistant description", () => {
    const manifest = buildManifest(webhookUrl, {
      appName: "Second Helper",
      appDescription: "Another fictional assistant",
      bgColor: "#abcdef",
    });
    expect(manifest).toBe(expectedManifest
      .replace("name: Example Helper", "name: Second Helper")
      .replaceAll("A fictional workspace assistant", "Another fictional assistant")
      .replace('background_color: "#234567"', 'background_color: "#abcdef"')
      .replace("display_name: example-helper", "display_name: second-helper"));
  });
});
