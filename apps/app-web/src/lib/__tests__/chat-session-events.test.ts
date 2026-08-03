import { describe, expect, it } from "vitest";
import { shouldAcceptRoomMirror } from "../chat-session-events";

const base = {
  senderUserId: "user-1",
  viewerUserId: "user-1",
  sessionId: "room-1",
  directTurnSessionId: "room-1",
  directStreamInFlight: true,
};

describe("[COMP:app-web/chat-surface] room live-progress ownership", () => {
  it("suppresses an own mirror only while this room's direct POST is live", () => {
    expect(shouldAcceptRoomMirror(base)).toBe(false);
  });

  it("suppresses the exact-room mirror before viewer identity hydrates", () => {
    expect(
      shouldAcceptRoomMirror({
        ...base,
        senderUserId: null,
        viewerUserId: null,
      }),
    ).toBe(false);
  });

  it("accepts the returning sender's mirror after navigation released the POST", () => {
    expect(
      shouldAcceptRoomMirror({
        ...base,
        directTurnSessionId: null,
        directStreamInFlight: false,
      }),
    ).toBe(true);
  });

  it("accepts own activity when the remaining direct POST belongs to another room", () => {
    expect(
      shouldAcceptRoomMirror({
        ...base,
        directTurnSessionId: "room-2",
      }),
    ).toBe(true);
  });

  it("always accepts a teammate's mirrored turn", () => {
    expect(
      shouldAcceptRoomMirror({
        ...base,
        senderUserId: "user-2",
      }),
    ).toBe(true);
  });
});
