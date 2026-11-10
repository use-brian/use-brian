/**
 * [COMP:chat-ui/pixel-landmark] The workspace landmark grid is stable and
 * complete enough for both the avatar and the public social image.
 */

import { describe, expect, it } from "vitest";
import { pixelLandmarkGrid } from "../pixel-landmark";

describe("[COMP:chat-ui/pixel-landmark]", () => {
  it("returns a 9x9 grid with a filled ground row", () => {
    const mark = pixelLandmarkGrid(42);
    expect(mark.cells).toHaveLength(9);
    expect(mark.cells.every((row) => row.length === 9)).toBe(true);
    expect(mark.cells[8].every((cell) => cell !== null)).toBe(true);
    expect(mark.background.startsWith("hsl(")).toBe(true);
  });

  it("is stable for a seed, including the negative form the avatar passes through", () => {
    expect(pixelLandmarkGrid(42)).toEqual(pixelLandmarkGrid(42));
    expect(pixelLandmarkGrid(-7)).toEqual(pixelLandmarkGrid(7));
    expect(pixelLandmarkGrid(1)).not.toEqual(pixelLandmarkGrid(2));
  });
});
