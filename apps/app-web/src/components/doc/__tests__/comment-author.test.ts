import { describe, it, expect } from "vitest";
import { resolveCommentAuthor } from "../comment-thread-body";
import type { DocSessionMessage } from "@/lib/api/sessions";

/**
 * [COMP:app-web/comment-thread-body] author resolution.
 *
 * `resolveCommentAuthor` is the single seam all three comment surfaces (thread
 * body, rail preview, page-comments band) use to attribute a message row. The
 * regression it guards: a comment authored by *another* workspace member used
 * to resolve to an empty name, which the `Avatar` rendered as a generic "?"
 * because the client only knew the current viewer's name. The route now sends a
 * server-resolved `senderName`, and this helper must surface it.
 */

const assistant = {
  id: "a1",
  name: "Doc",
  isAssistant: true as const,
  iconSeed: 7,
};

function msg(over: Partial<DocSessionMessage>): DocSessionMessage {
  return {
    id: "m1",
    role: "user",
    content: "hi",
    timestamp: "2026-05-30T00:00:00.000Z",
    senderUserId: null,
    senderName: null,
    ...over,
  };
}

describe("[COMP:app-web/comment-thread-body] resolveCommentAuthor", () => {
  it("returns the assistant identity for assistant rows", () => {
    const a = resolveCommentAuthor(msg({ role: "assistant" }), {
      currentUser: { id: "u1", name: "Ada" },
      assistant,
    });
    expect(a).toEqual(assistant);
  });

  it("uses the current viewer's own (freshest) name for their rows", () => {
    const a = resolveCommentAuthor(
      msg({ senderUserId: "u1", senderName: "Stale Server Name" }),
      { currentUser: { id: "u1", name: "Ada" }, assistant },
    );
    expect(a).toEqual({ id: "u1", name: "Ada", avatarUrl: undefined });
  });

  it("uses the server-resolved senderName for another member's rows", () => {
    const a = resolveCommentAuthor(
      msg({ senderUserId: "u2", senderName: "Grace Hopper" }),
      { currentUser: { id: "u1", name: "Ada" }, assistant },
    );
    // The fix: a teammate is named, not rendered as a blank "?" avatar.
    expect(a).toEqual({ id: "u2", name: "Grace Hopper", avatarUrl: null });
  });

  it("falls back to an empty name (→ Avatar '?') only for a truly unknown sender", () => {
    const a = resolveCommentAuthor(
      msg({ senderUserId: "u3", senderName: null }),
      { currentUser: { id: "u1", name: "Ada" }, assistant },
    );
    expect(a).toEqual({ id: "u3", name: "", avatarUrl: null });
  });

  it("names a teammate even when there is no current viewer in context", () => {
    const a = resolveCommentAuthor(
      msg({ senderUserId: "u2", senderName: "Grace" }),
      { assistant },
    );
    expect(a).toEqual({ id: "u2", name: "Grace", avatarUrl: null });
  });

  it("surfaces a teammate's server-resolved avatar URL", () => {
    const a = resolveCommentAuthor(
      msg({ senderUserId: "u2", senderName: "Grace", senderAvatarUrl: "https://x/g.png" }),
      { currentUser: { id: "u1", name: "Ada" }, assistant },
    );
    expect(a).toEqual({ id: "u2", name: "Grace", avatarUrl: "https://x/g.png" });
  });

  it("uses the viewer's own (freshest) avatar from the cookie for their rows", () => {
    const a = resolveCommentAuthor(
      // A stale server avatar on the viewer's own row is ignored in favour of
      // the cookie-sourced one.
      msg({ senderUserId: "u1", senderName: "Ada", senderAvatarUrl: "https://x/stale.png" }),
      { currentUser: { id: "u1", name: "Ada", avatarUrl: "https://x/fresh.png" }, assistant },
    );
    expect(a).toEqual({ id: "u1", name: "Ada", avatarUrl: "https://x/fresh.png" });
  });
});
