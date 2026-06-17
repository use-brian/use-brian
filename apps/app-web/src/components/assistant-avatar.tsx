"use client";

/**
 * Deterministic pixel creature avatar for assistants.
 * Pokemon/Tamagotchi-inspired pixel companions — blobs, critters, ghosts.
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

// Body templates: 9-wide, stored as 5 cols [c0,c1,c2,c3,c4] where c4=center.
// Mirrored at render: [c0,c1,c2,c3,c4,c3,c2,c1,c0]
// Each template is 5 rows (body occupies rows 2-6 of a 9-tall grid)
const BODIES = [
  // Round blob
  [[0, 0, 1, 1, 1], [0, 1, 1, 1, 1], [0, 1, 1, 1, 1], [0, 0, 1, 1, 1], [0, 0, 0, 1, 0]],
  // Ghost
  [[0, 0, 1, 1, 1], [0, 1, 1, 1, 1], [0, 1, 1, 1, 1], [0, 1, 1, 1, 1], [0, 1, 0, 1, 0]],
  // Cat
  [[0, 1, 0, 0, 0], [1, 1, 1, 1, 1], [0, 1, 1, 1, 1], [0, 1, 1, 1, 1], [0, 0, 1, 0, 0]],
  // Slime
  [[0, 0, 0, 1, 1], [0, 0, 1, 1, 1], [0, 1, 1, 1, 1], [1, 1, 1, 1, 1], [0, 0, 0, 0, 0]],
  // Bear
  [[0, 1, 0, 1, 0], [1, 1, 1, 1, 1], [0, 1, 1, 1, 1], [0, 1, 1, 1, 1], [0, 0, 1, 1, 0]],
  // Alien
  [[0, 1, 1, 1, 1], [1, 1, 1, 1, 1], [0, 0, 1, 1, 1], [0, 0, 1, 1, 1], [0, 0, 0, 1, 0]],
  // Squid
  [[0, 0, 1, 1, 1], [0, 1, 1, 1, 1], [0, 1, 1, 1, 1], [0, 1, 0, 1, 0], [1, 0, 1, 0, 1]],
  // Mushroom
  [[0, 1, 1, 1, 1], [1, 1, 1, 1, 1], [0, 0, 1, 1, 1], [0, 0, 0, 1, 1], [0, 0, 0, 1, 1]],
  // Bird
  [[0, 0, 0, 1, 1], [0, 1, 1, 1, 1], [1, 1, 1, 1, 1], [0, 1, 1, 1, 1], [0, 0, 1, 0, 0]],
  // Star blob
  [[0, 1, 0, 1, 0], [0, 1, 1, 1, 1], [1, 1, 1, 1, 1], [0, 1, 1, 1, 1], [0, 1, 0, 1, 0]],
  // Bunny
  [[0, 1, 0, 0, 0], [0, 1, 0, 0, 0], [0, 1, 1, 1, 1], [0, 1, 1, 1, 1], [0, 0, 1, 0, 0]],
  // Cube
  [[0, 0, 0, 0, 0], [0, 1, 1, 1, 1], [0, 1, 1, 1, 1], [0, 1, 1, 1, 1], [0, 0, 0, 0, 0]],
];

function generatePixelCreature(seed: number, size: number): El[] {
  const rng = mulberry32(seed);
  const r = () => rng();

  const G = 9;
  const px = size / G;

  const hue = r() * 360;
  // Saturated, slightly-deeper pastel so the creature's card keeps a visible
  // edge against the white doc surface — the old 90–97% lightness washed
  // straight into the page. Still exactly two rng() draws, so getIconColor()
  // (which skips two randoms here) stays in sync.
  const bg = hsl(hue, 55 + r() * 25, 82 + r() * 6);
  const body = hsl(hue, 55 + r() * 30, 50 + r() * 20);
  const bodyL = hsl(hue, 45 + r() * 20, 65 + r() * 15);
  const eye = "#1a1a2e";

  const bi = Math.floor(r() * BODIES.length);
  const tmpl = BODIES[bi];
  const eyeW = Math.floor(r() * 2); // 0=narrow(3,5), 1=wide(2,6)
  const hasMouth = r() > 0.3;
  const hasCheeks = r() > 0.5;
  const hasShine = r() > 0.35;
  const hasSpot = r() > 0.6;
  const spotColor = hsl((hue + 120 + r() * 80) % 360, 50 + r() * 30, 60 + r() * 15);

  // Build grid
  const grid: (string | null)[][] = Array.from({ length: G }, () => Array(G).fill(null));
  const oy = 2; // body starts at row 2

  // Fill body
  for (let ty = 0; ty < tmpl.length; ty++) {
    const row = tmpl[ty];
    const full = [row[0], row[1], row[2], row[3], row[4], row[3], row[2], row[1], row[0]];
    for (let x = 0; x < 9; x++) {
      if (full[x]) grid[oy + ty][x] = ty < 2 ? bodyL : body;
    }
  }

  // Decorative spots on body
  if (hasSpot) {
    const spotRow = oy + 1 + Math.floor(r() * 2);
    const spotCol = 3 + Math.floor(r() * 3);
    if (grid[spotRow]?.[spotCol]) grid[spotRow][spotCol] = spotColor;
    // Mirror
    const mirrorCol = 8 - spotCol;
    if (grid[spotRow]?.[mirrorCol]) grid[spotRow][mirrorCol] = spotColor;
  }

  // Eyes (on row oy+2)
  const eyeRow = oy + 2;
  const eL = eyeW === 0 ? 3 : 2;
  const eR = eyeW === 0 ? 5 : 6;
  if (grid[eyeRow]?.[eL]) grid[eyeRow][eL] = eye;
  if (grid[eyeRow]?.[eR]) grid[eyeRow][eR] = eye;

  // Eye shine
  if (hasShine) {
    const shineRow = eyeRow - 1;
    if (grid[shineRow]?.[eL] !== null || grid[eyeRow]?.[eL]) {
      // Place shine above or on the eye pixel
      if (grid[shineRow]?.[eL]) grid[shineRow][eL] = "rgba(255,255,255,0.7)";
      if (grid[shineRow]?.[eR]) grid[shineRow][eR] = "rgba(255,255,255,0.7)";
    }
  }

  // Mouth (row oy+3, center)
  if (hasMouth && grid[oy + 3]?.[4]) {
    grid[oy + 3][4] = eye;
  }

  // Cheeks
  if (hasCheeks) {
    const cheekColor = hsl(350, 50, 72);
    const cL = eyeW === 0 ? 2 : 1;
    const cR = eyeW === 0 ? 6 : 7;
    if (grid[oy + 3]?.[cL]) grid[oy + 3][cL] = cheekColor;
    if (grid[oy + 3]?.[cR]) grid[oy + 3][cR] = cheekColor;
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

/**
 * Returns the dominant body hex color for a given icon seed.
 * Mirrors the hue/saturation/lightness logic in generatePixelCreature.
 */
export function getIconColor(seed: number): string {
  const rng = mulberry32(Math.abs(seed));
  const hue = rng() * 360;
  // Skip bg randoms (sat, lightness)
  rng(); rng();
  const sat = 55 + rng() * 30;
  const light = 50 + rng() * 20;
  // Convert HSL to hex
  const h = hue / 360;
  const s = sat / 100;
  const l = light / 100;
  const a2 = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const c = l - a2 * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function AssistantAvatar({
  id,
  name,
  iconSeed,
  size = "md",
}: {
  id: string;
  name: string;
  iconSeed?: number;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  const seed = iconSeed ?? Array.from(id).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
  const s = size === "sm" ? 28 : size === "md" ? 40 : size === "lg" ? 56 : 96;

  return (
    <svg
      width={s}
      height={s}
      viewBox={`0 0 ${s} ${s}`}
      className="shrink-0"
      style={{ borderRadius: s * 0.18 }}
      aria-label={name}
    >
      {generatePixelCreature(Math.abs(seed), s)}
    </svg>
  );
}
