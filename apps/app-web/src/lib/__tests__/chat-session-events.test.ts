import { describe, expect, it } from "vitest";
import {
  shouldAcceptRoomMirror,
  shouldOpenSessionStream,
  shouldReopenSessionStream,
} from "../chat-session-events";

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

describe("[COMP:app-web/turn-reconnect] personal-session stream open / reopen", () => {
  it("always opens the follow stream for a room", () => {
    expect(shouldOpenSessionStream({ isRoom: true, reconnectWanted: false })).toBe(true);
    expect(shouldOpenSessionStream({ isRoom: true, reconnectWanted: true })).toBe(true);
  });

  it("opens a non-room stream only while a re-attach is wanted", () => {
    expect(shouldOpenSessionStream({ isRoom: false, reconnectWanted: false })).toBe(false);
    expect(shouldOpenSessionStream({ isRoom: false, reconnectWanted: true })).toBe(true);
  });

  it("reopens a room stream after any close", () => {
    expect(shouldReopenSessionStream({ isRoom: true, sawDone: false, cancelled: false })).toBe(true);
    expect(shouldReopenSessionStream({ isRoom: true, sawDone: true, cancelled: false })).toBe(true);
  });

  it("never reopens a non-room stream after the immediate not-running done", () => {
    // status { idle } -> done {} -> end: the route answered "nothing to attach to".
    expect(shouldReopenSessionStream({ isRoom: false, sawDone: true, cancelled: false })).toBe(false);
  });

  it("never reopens a non-room stream after the post-turn_completed done", () => {
    // ... turn_completed {} -> done {} -> end: the turn is over; the transcript was refetched.
    expect(shouldReopenSessionStream({ isRoom: false, sawDone: true, cancelled: false })).toBe(false);
  });

  it("reopens a non-room stream on a bare close (no done)", () => {
    expect(shouldReopenSessionStream({ isRoom: false, sawDone: false, cancelled: false })).toBe(true);
  });

  it("never reopens once the effect was cancelled", () => {
    expect(shouldReopenSessionStream({ isRoom: true, sawDone: false, cancelled: true })).toBe(false);
    expect(shouldReopenSessionStream({ isRoom: false, sawDone: false, cancelled: true })).toBe(false);
  });
});
