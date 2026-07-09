import { describe, expect, it } from "vitest";
import { collapseResolvedConfirmations } from "../confirmation-collapse";

const conf = (status: string, id: string) => ({ status, toolCallId: id });

describe("[COMP:app-web/confirmation-collapse] resolved-confirmation collapse policy", () => {
  it("renders 0-2 resolved rows individually (no summary)", () => {
    expect(collapseResolvedConfirmations([])).toEqual({
      counts: null,
      tail: [],
    });

    const two = [conf("approved", "a"), conf("denied", "b")];
    const { counts, tail } = collapseResolvedConfirmations(two);
    expect(counts).toBeNull();
    expect(tail).toEqual(two);
  });

  it("collapses everything but the newest at 3+ rows", () => {
    const rows = [
      conf("approved", "a"),
      conf("approved", "b"),
      conf("denied", "c"),
      conf("failed", "d"),
      conf("approved", "e"),
    ];
    const { counts, tail } = collapseResolvedConfirmations(rows);
    expect(counts).toEqual({ approved: 2, denied: 1, failed: 1 });
    expect(tail).toEqual([conf("approved", "e")]);
  });

  it("keeps a just-failed row visible as the newest receipt", () => {
    const rows = [
      conf("approved", "a"),
      conf("approved", "b"),
      conf("failed", "c"),
    ];
    const { counts, tail } = collapseResolvedConfirmations(rows);
    expect(counts).toEqual({ approved: 2, denied: 0, failed: 0 });
    expect(tail).toEqual([conf("failed", "c")]);
  });

  it("caps the resolved block at two rows no matter the run length", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      conf("approved", `id-${i}`),
    );
    const { counts, tail } = collapseResolvedConfirmations(rows);
    expect(counts).toEqual({ approved: 39, denied: 0, failed: 0 });
    expect(tail).toHaveLength(1);
    expect(tail[0]).toEqual(conf("approved", "id-39"));
  });
});
