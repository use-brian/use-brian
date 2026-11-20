import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { format } from "@/lib/i18n/format";
import { en } from "@/lib/i18n/dictionaries/en";
import { ja } from "@/lib/i18n/dictionaries/ja";
import { zh } from "@/lib/i18n/dictionaries/zh";
import { zhCN } from "@/lib/i18n/dictionaries/zh-cn";
import type { ConversationNotice } from "@/lib/chat/conversation-controller";

/**
 * [COMP:app-web/chat-surface] The full page maps the conversation
 * controller's typed notice codes to existing dictionary keys (copy stays in
 * the presentation). The mapper is extracted from production source, the
 * same AST pattern as the surface ownership tests.
 */
const source = readFileSync(new URL("../chat-surface.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("chat-surface.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let expression = "";
(function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "pageNoticeCopy") expression = node.initializer!.getText(tree);
  ts.forEachChild(node, visit);
})(tree);
const code = ts.transpileModule(`return (${expression});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
type Mapper = (
  notice: ConversationNotice,
  copy: { chatApp: typeof en.chatApp; chat: typeof en.chat },
  context: { viewerId: string | null; ownsDirectRun: boolean; stoppedByViewer?: boolean; clearanceNames?: { rejected: string | null; skipped: string | null }; conversation?: "room" | "message" },
) => { slot: string; text: string } | null;
const pageNoticeCopy = new Function("format", code)(format) as Mapper;

const quiet = { viewerId: "viewer-1" as string | null, ownsDirectRun: false };
const notices: ConversationNotice[] = [
  { code: "reconnecting" },
  { code: "reconnectFailed", cause: "budget" },
  { code: "reconnectFailed", cause: "rejected", status: 403 },
  { code: "turnEnd", reason: "stalled_reclaimed", stoppedByName: null, senderUserId: null },
  { code: "turnEnd", reason: "timeout", stoppedByName: null, senderUserId: null },
  { code: "turnEnd", reason: "failed", stoppedByName: null, senderUserId: null },
  { code: "turnEnd", reason: "stopped_by_user", stoppedByName: "Avery Example", senderUserId: null },
  { code: "turnEnd", reason: "stopped_by_user", stoppedByName: null, senderUserId: null },
  { code: "queued" },
  { code: "turnNotice", notice: "budget_downgraded" },
  { code: "turnNotice", notice: "custom_model_image_fallback" },
  { code: "turnNotice", notice: "custom_model_endpoint_fallback" },
  { code: "turnNotice", notice: "post_reply_authority_changed" },
  { code: "stopTurnFailed" },
  { code: "confirmNotAllowed" },
  { code: "error", errorCode: "assistant_clearance_exceeds_room" },
  { code: "error", errorCode: "upstream_connection_reset" },
  { code: "error", errorCode: "upstream_connection_reset", customEndpoint: true },
  { code: "error", errorCode: "upstream_unreachable" },
  { code: "error", errorCode: "upstream_unreachable", customEndpoint: true },
  { code: "error", errorCode: "stream_failed" },
];

describe("[COMP:app-web/chat-surface] controller notice copy", () => {
  it("maps each typed notice to the page's existing English copy and slot", () => {
    const copy = { chatApp: en.chatApp, chat: en.chat };
    expect(pageNoticeCopy({ code: "reconnecting" }, copy, quiet)).toEqual({ slot: "reconnect", text: en.chatApp.turnReconnecting });
    expect(pageNoticeCopy({ code: "reconnectFailed", cause: "budget" }, copy, quiet)).toEqual({ slot: "error", text: en.chat.turnReconnectFailed });
    expect(pageNoticeCopy({ code: "turnEnd", reason: "timeout", stoppedByName: null, senderUserId: null }, copy, quiet)?.text).toBe(en.chatApp.turnReclaimed);
    expect(pageNoticeCopy({ code: "turnEnd", reason: "stopped_by_user", stoppedByName: "Avery Example", senderUserId: null }, copy, quiet)?.text)
      .toBe("Avery Example stopped this turn.");
    expect(pageNoticeCopy({ code: "queued" }, copy, quiet)).toEqual({ slot: "queued", text: en.chatApp.queuedNotice });
    expect(pageNoticeCopy({ code: "stopTurnFailed" }, copy, quiet)).toEqual({ slot: "error", text: en.chatApp.stopTurnFailed });
    expect(pageNoticeCopy({ code: "confirmNotAllowed" }, copy, quiet)).toEqual({ slot: "error", text: en.chatApp.confirmNotAllowed });
    expect(pageNoticeCopy({ code: "error", errorCode: "upstream_unreachable", customEndpoint: true }, copy, quiet)?.text)
      .toBe(en.chatApp.upstreamUnreachableCustom);
    expect(pageNoticeCopy({ code: "servedBy", assistantId: "assistant-1" }, copy, quiet)).toBeNull();
  });

  it("attributes a nameless stop to the viewer only when the viewer sent the turn", () => {
    const copy = { chatApp: en.chatApp, chat: en.chat };
    const stop = (senderUserId: string | null): ConversationNotice => ({ code: "turnEnd", reason: "stopped_by_user", stoppedByName: null, senderUserId });
    expect(pageNoticeCopy(stop(null), copy, quiet)?.text).toBe(en.chatApp.turnStopped);
    expect(pageNoticeCopy(stop(null), copy, { ...quiet, viewerId: null })?.text).toBe(en.chatApp.turnStopped);
    expect(pageNoticeCopy(stop("teammate-2"), copy, quiet)?.text).toBe(en.chatApp.turnStopped);
    expect(pageNoticeCopy(stop("viewer-1"), copy, quiet)?.text).toBe(en.chatApp.turnStoppedByYou);
  });

  it("a Stop this presentation asked for is the viewer's even when the server names the stopper", () => {
    const copy = { chatApp: en.chatApp, chat: en.chat };
    const named: ConversationNotice = { code: "turnEnd", reason: "stopped_by_user", stoppedByName: "Avery Example", senderUserId: "viewer-1" };
    expect(pageNoticeCopy(named, copy, { ...quiet, stoppedByViewer: true })?.text).toBe(en.chatApp.turnStoppedByYou);
    expect(pageNoticeCopy(named, copy, quiet)?.text).toBe("Avery Example stopped this turn.");
  });

  it("keeps a failed turn quiet for the sender whose POST already reported it", () => {
    const copy = { chatApp: en.chatApp, chat: en.chat };
    const failed: ConversationNotice = { code: "turnEnd", reason: "failed", stoppedByName: null, senderUserId: null };
    expect(pageNoticeCopy(failed, copy, quiet)?.text).toBe(en.chatApp.turnFailed);
    expect(pageNoticeCopy(failed, copy, { ...quiet, ownsDirectRun: true })).toBeNull();
    expect(pageNoticeCopy({ code: "turnEnd", reason: "completed", stoppedByName: null, senderUserId: null }, copy, quiet)).toBeNull();
  });

  it("shows server-authored text only for codes this build does not translate", () => {
    const copy = { chatApp: en.chatApp, chat: en.chat };
    expect(pageNoticeCopy({ code: "error", errorCode: "brand_new_code", message: "Server sentence." }, copy, quiet)?.text).toBe("Server sentence.");
    expect(pageNoticeCopy({ code: "error", errorCode: "brand_new_code" }, copy, quiet)?.text).toBe(en.chatApp.errorGeneric);
    expect(pageNoticeCopy({ code: "error", errorCode: "upstream_connection_reset", message: "raw socket" }, copy, quiet)?.text)
      .toBe(en.chatApp.upstreamConnectionReset);
    expect(pageNoticeCopy({ code: "turnNotice", notice: "brand_new_notice" }, copy, quiet)).toBeNull();
    expect(pageNoticeCopy({ code: "turnNotice", notice: "brand_new_notice", message: "Served differently." }, copy, quiet)?.text).toBe("Served differently.");
    expect(pageNoticeCopy({ code: "error", errorCode: "delivery_audience_unverified" }, copy, quiet)?.text).toBe(en.chatApp.errorGeneric);
    expect(pageNoticeCopy({ code: "error", errorCode: "delivery_audience_unverified", sharedChat: true }, copy, quiet)?.text)
      .toBe(en.chatApp.deliveryAudienceBlocked);
  });

  it.each([["en", en], ["ja", ja], ["zh", zh], ["zh-cn", zhCN]] as const)("every notice has %s copy without em dashes", (_locale, dictionary) => {
    const copy = { chatApp: dictionary.chatApp, chat: dictionary.chat };
    for (const notice of notices) {
      const result = pageNoticeCopy(notice, copy, quiet);
      if (notice.code === "turnEnd" && notice.reason === "failed") expect(result?.text).toBe(dictionary.chatApp.turnFailed);
      expect(result?.text, JSON.stringify(notice)).toBeTruthy();
      expect(result!.text).not.toContain("—");
    }
  });
});

describe("[COMP:app-web/chat-surface] assistant_clearance_below_conversation copy", () => {
  const code = "assistant_clearance_below_conversation";
  const named = { rejected: "Avery Helper", skipped: "Blair Helper" };
  it("names the assistant, never a clearance level, for a rejected mention and a skipped member", () => {
    const copy = { chatApp: en.chatApp, chat: en.chat };
    const room = { ...quiet, clearanceNames: named, conversation: "room" as const };
    const personal = { ...quiet, clearanceNames: named, conversation: "message" as const };
    expect(pageNoticeCopy({ code: "error", errorCode: code, message: "server text" }, copy, room)).toEqual({
      slot: "error",
      text: "Avery Helper is not cleared to read this room, so it cannot answer here. Remove the mention, or ask a workspace admin to raise its clearance.",
    });
    expect(pageNoticeCopy({ code: "turnNotice", notice: code, message: "server text" }, copy, room)).toEqual({
      slot: "turnNotice",
      text: "Blair Helper was skipped because it is not cleared to read this room. A workspace admin can raise its clearance.",
    });
    expect(pageNoticeCopy({ code: "error", errorCode: code }, copy, personal)?.text).toContain("this message");
    expect(pageNoticeCopy({ code: "turnNotice", notice: code }, copy, personal)?.text).toContain("this message");
  });

  it("falls back to the server's own sentence when the assistant is unknown", () => {
    const copy = { chatApp: en.chatApp, chat: en.chat };
    const unknown = { ...quiet, clearanceNames: { rejected: null, skipped: null }, conversation: "room" as const };
    expect(pageNoticeCopy({ code: "error", errorCode: code, message: "Server sentence." }, copy, unknown)?.text).toBe("Server sentence.");
    expect(pageNoticeCopy({ code: "turnNotice", notice: code, message: "Server skip." }, copy, unknown)?.text).toBe("Server skip.");
    expect(pageNoticeCopy({ code: "error", errorCode: code }, copy, unknown)?.text).toBe(en.chatApp.errorGeneric);
  });

  it.each([["en", en], ["ja", ja], ["zh", zh], ["zh-cn", zhCN]] as const)("has %s copy with the name filled in and no em dash", (_locale, dictionary) => {
    const copy = { chatApp: dictionary.chatApp, chat: dictionary.chat };
    for (const conversation of ["room", "message"] as const) {
      const context = { ...quiet, clearanceNames: named, conversation };
      for (const notice of [{ code: "error", errorCode: code }, { code: "turnNotice", notice: code }] as ConversationNotice[]) {
        const text = pageNoticeCopy(notice, copy, context)!.text;
        expect(text).toMatch(/Avery Helper|Blair Helper/);
        expect(text).not.toContain("{name}");
        expect(text).not.toContain("\u2014");
      }
    }
  });
});
