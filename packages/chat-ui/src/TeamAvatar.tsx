"use client";

/**
 * Deterministic pixel landmark avatar for teams.
 * Iconic architecture from around the globe — each team gets a unique landmark.
 * Complements the pixel creature avatars used by assistants.
 */

import React from "react";
import { pixelLandmarkGrid } from "./pixel-landmark";

function landmarkRects(seed: number, size: number): React.ReactElement[] {
  const { background, cells } = pixelLandmarkGrid(seed);
  const px = size / 9;
  const els: React.ReactElement[] = [
    <rect key="bg" width={size} height={size} rx={size * 0.18} fill={background} />,
  ];
  let k = 0;
  for (let y = 0; y < cells.length; y++) {
    for (let x = 0; x < cells[y].length; x++) {
      const color = cells[y][x];
      if (!color) continue;
      els.push(
        <rect
          key={k++}
          x={Math.floor(x * px)}
          y={Math.floor(y * px)}
          width={Math.ceil(px) + 0.5}
          height={Math.ceil(px) + 0.5}
          fill={color}
        />,
      );
    }
  }
  return els;
}

export function TeamAvatar({
  id,
  name,
  iconSeed,
  iconUrl,
  size = "md",
}: {
  id: string;
  name: string;
  iconSeed?: number | null;
  iconUrl?: string | null;
  size?: "xs" | "sm" | "md" | "lg";
}) {
  const [imageFailed, setImageFailed] = React.useState(false);
  React.useEffect(() => setImageFailed(false), [iconUrl]);

  const seed = iconSeed ?? Array.from(id).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
  // xs (18px) is the compact switcher size — roughly the label's cap height
  // beside it, Notion-style, so the icon doesn't dominate the row.
  const s = size === "xs" ? 18 : size === "sm" ? 28 : size === "md" ? 40 : 56;

  if (iconUrl && !imageFailed) {
    return (
      <img
        src={iconUrl}
        alt={name}
        width={s}
        height={s}
        className="shrink-0 object-cover"
        style={{ width: s, height: s, borderRadius: s * 0.18 }}
        onError={() => setImageFailed(true)}
      />
    );
  }

  return (
    <svg
      width={s}
      height={s}
      viewBox={`0 0 ${s} ${s}`}
      className="shrink-0"
      style={{ borderRadius: s * 0.18 }}
      aria-label={name}
    >
      {landmarkRects(seed, s)}
    </svg>
  );
}
