/**
 * Deterministic 9×9 pixel landmark shared by the workspace avatar and the
 * public page social image. One generator so a published thumbnail shows the
 * same mark the workspace switcher does when no picture is uploaded.
 *
 * [COMP:chat-ui/pixel-landmark]
 */

function mulberry32(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%)`;
}

// Landmark templates: 9x9 grids, stored as 5 cols [c0,c1,c2,c3,c4] mirrored.
// 1 = structure, 2 = accent/detail, 3 = window/opening
// Each landmark occupies rows 1-8 (row 0 spare, row 8 = ground)
const LANDMARKS: { name: string; grid: number[][] }[] = [
  { name: "Eiffel Tower", grid: [
    [0, 0, 0, 0, 1], [0, 0, 0, 0, 1], [0, 0, 0, 1, 1],
    [0, 0, 0, 1, 3], [0, 0, 1, 2, 1], [0, 0, 1, 0, 0],
    [0, 1, 1, 0, 0], [1, 1, 0, 0, 0], [1, 0, 0, 0, 0],
  ]},
  { name: "Big Ben", grid: [
    [0, 0, 0, 0, 1], [0, 0, 0, 1, 2], [0, 0, 0, 1, 3],
    [0, 0, 0, 1, 2], [0, 0, 0, 1, 1], [0, 0, 0, 1, 3],
    [0, 0, 0, 1, 3], [0, 0, 1, 1, 1], [0, 1, 1, 1, 1],
  ]},
  { name: "Taj Mahal", grid: [
    [0, 0, 0, 0, 1], [0, 0, 0, 1, 2], [0, 0, 0, 1, 1],
    [0, 1, 0, 1, 1], [0, 1, 1, 1, 1], [0, 1, 1, 1, 3],
    [0, 1, 1, 1, 1], [0, 1, 1, 1, 1], [1, 1, 1, 1, 1],
  ]},
  { name: "Pyramid", grid: [
    [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 1],
    [0, 0, 0, 0, 1], [0, 0, 0, 1, 1], [0, 0, 0, 1, 1],
    [0, 0, 1, 1, 1], [0, 1, 1, 1, 1], [1, 1, 1, 1, 1],
  ]},
  { name: "Pagoda", grid: [
    [0, 0, 0, 0, 1], [0, 0, 1, 2, 2], [0, 0, 0, 1, 3],
    [0, 1, 1, 2, 2], [0, 0, 0, 1, 3], [1, 1, 1, 2, 2],
    [0, 0, 1, 1, 3], [0, 0, 1, 1, 1], [0, 1, 1, 1, 1],
  ]},
  { name: "Sydney Opera", grid: [
    [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 1],
    [0, 0, 0, 1, 1], [0, 0, 1, 0, 1], [0, 1, 1, 0, 1],
    [1, 1, 1, 1, 1], [1, 1, 1, 1, 1], [1, 1, 1, 1, 1],
  ]},
  { name: "Colosseum", grid: [
    [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 1, 1, 1, 1],
    [0, 1, 3, 1, 3], [0, 1, 1, 1, 1], [0, 1, 3, 1, 3],
    [0, 1, 1, 1, 1], [1, 1, 3, 1, 3], [1, 1, 1, 1, 1],
  ]},
  { name: "Torii Gate", grid: [
    [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0],
    [1, 2, 2, 2, 2], [0, 0, 1, 0, 1], [1, 2, 2, 2, 2],
    [0, 0, 1, 0, 1], [0, 0, 1, 0, 1], [0, 0, 1, 0, 1],
  ]},
  { name: "Windmill", grid: [
    [0, 0, 0, 1, 0], [0, 0, 0, 1, 2], [0, 0, 0, 1, 1],
    [0, 0, 0, 1, 1], [0, 0, 1, 1, 1], [0, 0, 1, 3, 1],
    [0, 1, 1, 1, 1], [0, 1, 1, 3, 1], [1, 1, 1, 1, 1],
  ]},
  { name: "Mosque", grid: [
    [0, 0, 0, 0, 2], [0, 0, 0, 0, 1], [0, 0, 0, 1, 1],
    [0, 1, 0, 0, 1], [0, 1, 1, 1, 1], [0, 1, 1, 3, 1],
    [0, 1, 1, 1, 1], [0, 1, 1, 3, 1], [1, 1, 1, 1, 1],
  ]},
  { name: "Castle", grid: [
    [0, 1, 0, 1, 0], [0, 1, 0, 1, 1], [0, 1, 1, 1, 1],
    [0, 1, 3, 1, 3], [0, 1, 1, 1, 1], [0, 1, 3, 1, 3],
    [0, 1, 1, 1, 1], [1, 1, 1, 1, 1], [1, 1, 1, 1, 1],
  ]},
  { name: "Lighthouse", grid: [
    [0, 0, 0, 0, 2], [0, 0, 0, 0, 1], [0, 0, 0, 1, 1],
    [0, 0, 0, 1, 3], [0, 0, 0, 1, 1], [0, 0, 1, 1, 1],
    [0, 0, 1, 3, 1], [0, 0, 1, 1, 1], [0, 1, 1, 1, 1],
  ]},
];

export type PixelLandmark = {
  /** Sky fill behind the structure. */
  background: string;
  /** 9×9 cells. `null` keeps the background. */
  cells: (string | null)[][];
};

/** The landmark for `seed`. Negative seeds match `TeamAvatar`'s abs. */
export function pixelLandmarkGrid(seed: number): PixelLandmark {
  const rng = mulberry32(Math.abs(seed));
  const r = () => rng();

  const G = 9;
  const hue = r() * 360;
  const skyHue = 200 + r() * 40;
  const background = hsl(skyHue, 25 + r() * 20, 88 + r() * 8);
  const structure = hsl(hue, 20 + r() * 25, 50 + r() * 15);
  const structureLight = hsl(hue, 15 + r() * 20, 65 + r() * 15);
  const accent = hsl((hue + 30 + r() * 40) % 360, 40 + r() * 30, 40 + r() * 15);
  const windowColor = hsl(skyHue, 30 + r() * 20, 75 + r() * 15);
  const ground = hsl(hue, 15, 38 + r() * 10);

  const landmark = LANDMARKS[Math.floor(r() * LANDMARKS.length)];
  const cells: (string | null)[][] = Array.from({ length: G }, () => Array(G).fill(null));

  for (let ty = 0; ty < landmark.grid.length && ty < G; ty++) {
    const row = landmark.grid[ty];
    const full = [row[0], row[1], row[2], row[3], row[4], row[3], row[2], row[1], row[0]];
    for (let x = 0; x < 9; x++) {
      const v = full[x];
      if (v === 1) cells[ty][x] = ty < 3 ? structureLight : structure;
      else if (v === 2) cells[ty][x] = accent;
      else if (v === 3) cells[ty][x] = windowColor;
    }
  }

  for (let x = 0; x < 9; x++) {
    if (!cells[8][x]) cells[8][x] = ground;
  }

  return { background, cells };
}
