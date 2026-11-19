/** [COMP:app-web/turn-frames] Boundary classification of direct and follow frames. */
import { describe, expect, it } from "vitest";
import { SURFACE_EFFECT_FRAMES, TURN_FRAME_NAMES, classifyTurnFrame, flushesPaint } from "../turn-frames";

/** The exact sets pinned by [COMP:api/turn-frame-contract]. */
const DIRECT = [
  "title_update", "session", "goal_accepted", "user_message_saved", "input_applied", "assistant_message_saved",
  "reply_text_complete", "text_delta", "reasoning", "worker_start", "tool_start", "tool_input", "tool_result",
  "tool_dropped", "research_saved", "page_created", "document_payload", "status", "citation", "attachments",
  "research_quota", "research_quota_exhausted", "queued", "input_queued", "mention_unreachable", "posted",
  "tool_confirmation_required", "notice", "error", "recording_participants_updated", "brain_entry_updated",
  "view_payload", "sub_page_created", "comment_posted", "comment_resolved",
  "doc_title_update", "doc_theme_update", "done", "reply_complete",
];
const FOLLOW = ["status", "user_message_saved", "turn_started", "assistant_message_saved", "snapshot", "activity",
  "pins_changed", "assistant_changed", "presence", "turn_completed", "done", "access_denied"];

describe("[COMP:app-web/turn-frames] frame boundary", () => {
  it("lists exactly the frames each stream emits", () => {
    expect([...TURN_FRAME_NAMES.direct].sort()).toEqual([...DIRECT].sort());
    expect([...TURN_FRAME_NAMES.follow].sort()).toEqual([...FOLLOW].sort());
    for (const name of ["turn_started", "tool_confirmation_resolved", "awaiting_approval"]) {
      expect(classifyTurnFrame("direct", name, {})).toMatchObject({ class: "ignorable", ignored: "unknown" });
    }
    expect(classifyTurnFrame("follow", "session_assistant_changed", {})).toMatchObject({ class: "ignorable" });
    expect(classifyTurnFrame("follow", "assistant_message_saved", { id: "row" }).class).toBe("lifecycle");
  });

  it("accepts a notice's kind as its code until the server sends code", () => {
    for (const kind of ["pdf_large_document", "pdf_reading", "distillation_unavailable", "transcription_unavailable"]) {
      expect(classifyTurnFrame("direct", "notice", { kind, fileName: "fixture.pdf" })).toMatchObject({ class: "notice", payload: { code: kind, kind } });
    }
    expect(classifyTurnFrame("direct", "notice", { code: "budget_downgraded", kind: "other" }).payload.code).toBe("budget_downgraded");
    expect(classifyTurnFrame("direct", "notice", { message: "no code or kind" })).toMatchObject({ class: "ignorable", ignored: "malformed" });
  });

  it("classifies surface effects exactly as the dispatch-once list", () => {
    expect([...SURFACE_EFFECT_FRAMES].sort()).toEqual([
      "brain_entry_updated", "comment_posted", "comment_resolved", "doc_theme_update", "doc_title_update",
      "page_created", "recording_participants_updated", "sub_page_created", "title_update", "view_payload",
    ]);
  });

  it("treats unknown, prototype and malformed frames as ignorable", () => {
    expect(classifyTurnFrame("direct", "future_frame", { a: 1 })).toMatchObject({ class: "ignorable", ignored: "unknown" });
    expect(classifyTurnFrame("direct", "constructor", {})).toMatchObject({ class: "ignorable", ignored: "unknown" });
    expect(classifyTurnFrame("follow", "text_delta", { text: "x" })).toMatchObject({ class: "ignorable", ignored: "unknown" });
    expect(classifyTurnFrame("follow", "access_denied", { code: "transport_unavailable" })).toMatchObject({ class: "ignorable" });
    expect(classifyTurnFrame("follow", "access_denied", { code: "conversation_access_denied" })).toMatchObject({ class: "terminal" });
    expect(classifyTurnFrame("direct", "tool_start", { name: "x" })).toMatchObject({ class: "ignorable", ignored: "malformed" });
    expect(classifyTurnFrame("direct", "user_message_saved", { id: 7 })).toMatchObject({ class: "ignorable", ignored: "malformed" });
    expect(classifyTurnFrame("direct", "notice", "not an object")).toMatchObject({ class: "ignorable" });
  });

  it("keeps original payload fields and tolerant optional fields", () => {
    const frame = classifyTurnFrame("direct", "text_delta", { text: 42, turnId: "t" });
    expect(frame).toMatchObject({ class: "paint", payload: { text: 42, turnId: "t" } });
    expect(flushesPaint(frame)).toBe(false);
    const done = classifyTurnFrame("follow", "turn_completed", { reason: "stopped_by_user", stoppedByName: null });
    expect(done.class).toBe("terminal");
    expect(flushesPaint(done)).toBe(true);
    expect(classifyTurnFrame("follow", "snapshot", { text: "so far" }).class).toBe("paint");
    expect(classifyTurnFrame("direct", "tool_confirmation_required", { toolCallId: "c" }).class).toBe("interaction");
  });
});
