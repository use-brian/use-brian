/**
 * [COMP:app-web/slash-command-autocomplete] General-chat host parity.
 *
 * The interaction contract lives in the shared hook/components. This source
 * seam prevents a composer refactor from silently dropping discovery or the
 * selected-command treatment from one of Brian's three general chat hosts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const hosts = [
  ["full-page Chat", source("../chat-surface.tsx")],
  ["universal workspace dock", source("../../chrome/floating-chat.tsx")],
  ["Feed assistant dock", source("../../feed/tuning-chat-panel.tsx")],
] as const;

describe("[COMP:app-web/slash-command-autocomplete] general chat hosts", () => {
  it.each(hosts)("keeps discovery and selected state in %s", (_name, host) => {
    expect(host).toContain("useSlashCommands({");
    expect(host).toContain("<SlashCommandMenuList");
    expect(host).toContain("<SlashCommandIndicator");
    expect(host).toContain("slashCommands.handleKeyDown");
  });

  it("paints the command prefix in both shared ChatComposer hosts", () => {
    expect(hosts[0][1]).toContain("...slashCommands.highlightRanges");
    expect(hosts[1][1]).toContain(
      "highlightRanges={slashCommands.highlightRanges}",
    );
  });
});

describe("[COMP:app-web/slash-command-autocomplete] full-page Chat at the conversation boundary", () => {
  it("sends a slash-shaped room message as an addressed turn through the conversation", async () => {
    const page = hosts[0][1];
    // The page decides the address (a slash command is an explicit address)
    // and hands it to the conversation as the typed `ask` extra.
    expect(page).toMatch(/const explicitAddress =[\s\S]*isSlashCommandShaped\(trimmed\)/);
    expect(page).toContain("...(panePolicy.post && explicitAddress ? { ask: true } : {})");
    const { createConversationController } = await import("@/lib/chat/conversation-controller");
    const { SCOPE, fakeScheduler, fakeTransport, settle } = await import("@/lib/chat/__tests__/conversation-fakes");
    const net = fakeTransport();
    const controller = createConversationController({ scope: SCOPE, sessionId: "room-1", room: true, transport: net.transport, scheduler: fakeScheduler().scheduler });
    controller.attach("page", { profile: "page" });
    void controller.send({ presentationId: "page", text: "/standup", bodyExtras: { ask: true, appOrigin: "chat" } });
    await settle();
    expect(net.lastChat().body).toMatchObject({ message: "/standup", sessionId: "room-1", ask: true, appOrigin: "chat" });
    net.lastChat().sse.close();
  });
});
