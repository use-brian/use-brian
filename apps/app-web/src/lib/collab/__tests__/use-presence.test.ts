import { describe, expect, it } from "vitest";
import { derivePresence } from "../use-presence";

type RawStates = Map<
  number,
  { user?: { id?: string; name?: string; color?: string }; active?: boolean }
>;

describe("[COMP:app-web/collab-presence] derivePresence", () => {
  it("returns one entry per person with others before self", () => {
    const states: RawStates = new Map([
      [1, { user: { id: "u-alice", name: "Alice", color: "#E5484D" } }],
      [2, { user: { id: "u-bob", name: "Bob", color: "#3E63DD" } }],
    ]);
    const out = derivePresence(states, /* localClientId */ 2);
    // Both default-active, so within the online group self (Bob) sorts last:
    // the pile reads "others, then you".
    expect(out.map((u) => u.name)).toEqual(["Alice", "Bob"]);
    expect(out.find((u) => u.id === "u-bob")?.isSelf).toBe(true);
    expect(out.find((u) => u.id === "u-alice")?.isSelf).toBe(false);
  });

  it("orders online (actively-viewing) peers ahead of away peers", () => {
    const states: RawStates = new Map([
      // Insertion order deliberately interleaves away/online to prove the
      // sort — not stable input order — does the work.
      [1, { user: { id: "u-alice", name: "Alice", color: "#E5484D" }, active: false }],
      [2, { user: { id: "u-bob", name: "Bob", color: "#3E63DD" }, active: true }],
      [3, { user: { id: "u-cara", name: "Cara", color: "#30A46C" }, active: false }],
      [4, { user: { id: "u-dan", name: "Dan", color: "#0091FF" }, active: true }],
    ]);
    const out = derivePresence(states, 99);
    // Online cluster (Bob, Dan) on the left; away peers (Alice, Cara) sink
    // right. Each group keeps its stable input order.
    expect(out.map((u) => u.name)).toEqual(["Bob", "Dan", "Alice", "Cara"]);
  });

  it("keeps yourself in the online cluster even while backgrounded (you never dim)", () => {
    const states: RawStates = new Map([
      [1, { user: { id: "u-alice", name: "Alice", color: "#E5484D" }, active: true }],
      [2, { user: { id: "u-bob", name: "Bob", color: "#3E63DD" }, active: false }],
      // Self, tab backgrounded → active:false, but self is never dimmed, so it
      // belongs with the online group (and sorts last within it).
      [3, { user: { id: "u-me", name: "Me", color: "#30A46C" }, active: false }],
    ]);
    const out = derivePresence(states, 3);
    expect(out.map((u) => u.name)).toEqual(["Alice", "Me", "Bob"]);
  });

  it("collapses the same person across tabs into one avatar", () => {
    const states: RawStates = new Map([
      [10, { user: { id: "u-alice", name: "Alice", color: "#E5484D" } }],
      [11, { user: { id: "u-alice", name: "Alice", color: "#E5484D" } }],
    ]);
    const out = derivePresence(states, 11);
    expect(out).toHaveLength(1);
    // Any tab being the local client marks the merged entry as self.
    expect(out[0].isSelf).toBe(true);
  });

  it("skips peers mid-handshake (no usable user field yet)", () => {
    const states: RawStates = new Map([
      [1, { user: { id: "u-alice", name: "Alice", color: "#E5484D" } }],
      [2, {}], // connected but hasn't published its user
      [3, { user: { name: "" } }], // empty name → not a real presence
    ]);
    const out = derivePresence(states, 99);
    expect(out.map((u) => u.name)).toEqual(["Alice"]);
  });

  it("falls back to the clientID + primary colour when fields are missing", () => {
    const states: RawStates = new Map([
      [7, { user: { name: "Ghost" } }], // no id, no color
    ]);
    const out = derivePresence(states, 1);
    expect(out[0].id).toBe("client:7");
    expect(out[0].color).toBe("var(--primary)");
  });

  it("treats a missing `active` flag as active (back-compat — never falsely dims)", () => {
    const states: RawStates = new Map([
      [1, { user: { id: "u-alice", name: "Alice", color: "#E5484D" } }],
    ]);
    expect(derivePresence(states, 99)[0].active).toBe(true);
  });

  it("carries through a backgrounded peer's inactive flag", () => {
    const states: RawStates = new Map([
      [1, { user: { id: "u-alice", name: "Alice", color: "#E5484D" }, active: false }],
      [2, { user: { id: "u-bob", name: "Bob", color: "#3E63DD" }, active: true }],
    ]);
    const out = derivePresence(states, 2);
    expect(out.find((u) => u.id === "u-alice")?.active).toBe(false);
    expect(out.find((u) => u.id === "u-bob")?.active).toBe(true);
  });

  it("is active if ANY of a person's tabs is foregrounded", () => {
    const states: RawStates = new Map([
      // Same person: one backgrounded tab, one focused tab → one active avatar.
      [10, { user: { id: "u-alice", name: "Alice", color: "#E5484D" }, active: false }],
      [11, { user: { id: "u-alice", name: "Alice", color: "#E5484D" }, active: true }],
    ]);
    const out = derivePresence(states, 99);
    expect(out).toHaveLength(1);
    expect(out[0].active).toBe(true);
  });
});
