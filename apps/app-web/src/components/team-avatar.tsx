"use client";

/**
 * Deterministic pixel landmark avatar for teams.
 * Iconic architecture from around the globe — each team gets a unique landmark.
 * Complements the pixel creature avatars used by assistants.
 */

import React from "react";

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

type El = React.ReactElement;

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

function generatePixelLandmark(seed: number, size: number): El[] {
  const rng = mulberry32(seed);
  const r = () => rng();

  const G = 9;
  const px = size / G;

  // Color palette — warm tones for structure, cool for sky
  const hue = r() * 360;
  const skyHue = 200 + r() * 40;
  const bg = hsl(skyHue, 25 + r() * 20, 88 + r() * 8);
  const structure = hsl(hue, 20 + r() * 25, 50 + r() * 15);
  const structureLight = hsl(hue, 15 + r() * 20, 65 + r() * 15);
  const accent = hsl((hue + 30 + r() * 40) % 360, 40 + r() * 30, 40 + r() * 15);
  const windowColor = hsl(skyHue, 30 + r() * 20, 75 + r() * 15);
  const ground = hsl(hue, 15, 38 + r() * 10);

  const li = Math.floor(r() * LANDMARKS.length);
  const landmark = LANDMARKS[li];

  // Build grid
  const grid: (string | null)[][] = Array.from({ length: G }, () => Array(G).fill(null));

  // Fill landmark
  for (let ty = 0; ty < landmark.grid.length && ty < G; ty++) {
    const row = landmark.grid[ty];
    const full = [row[0], row[1], row[2], row[3], row[4], row[3], row[2], row[1], row[0]];
    for (let x = 0; x < 9; x++) {
      const v = full[x];
      if (v === 1) grid[ty][x] = ty < 3 ? structureLight : structure;
      else if (v === 2) grid[ty][x] = accent;
      else if (v === 3) grid[ty][x] = windowColor;
    }
  }

  // Ground line
  for (let x = 0; x < 9; x++) {
    if (!grid[8][x]) grid[8][x] = ground;
  }

  // Render
  const els: El[] = [];
  let k = 0;

  els.push(<rect key={k++} width={size} height={size} rx={size * 0.18} fill={bg} />);

  for (let y = 0; y < G; y++) {
    for (let x = 0; x < G; x++) {
      const color = grid[y][x];
      if (color) {
        els.push(
          <rect
            key={k++}
            x={Math.floor(x * px)}
            y={Math.floor(y * px)}
            width={Math.ceil(px) + 0.5}
            height={Math.ceil(px) + 0.5}
            fill={color}
          />
        );
      }
    }
  }

  return els;
}

export function TeamAvatar({
  id,
  name,
  iconSeed,
  size = "md",
}: {
  id: string;
  name: string;
  iconSeed?: number | null;
  size?: "xs" | "sm" | "md" | "lg";
}) {
  const seed = iconSeed ?? Array.from(id).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
  // xs (18px) is the compact switcher size — roughly the label's cap height
  // beside it, Notion-style, so the icon doesn't dominate the row.
  const s = size === "xs" ? 18 : size === "sm" ? 28 : size === "md" ? 40 : 56;

  return (
    <svg
      width={s}
      height={s}
      viewBox={`0 0 ${s} ${s}`}
      className="shrink-0"
      style={{ borderRadius: s * 0.18 }}
      aria-label={name}
    >
      {generatePixelLandmark(Math.abs(seed), s)}
    </svg>
  );
}
