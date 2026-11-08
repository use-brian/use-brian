/**
 * Square social image for a public page: workspace mark, page icon, title.
 *
 * [COMP:app-web/page-social-image]
 */

import { ImageResponse } from "next/og";
import { pixelLandmarkGrid } from "@use-brian/chat-ui/pixel-landmark";
import {
  SOCIAL_IMAGE_SIZE,
  emojiGraphemes,
  loadEmojiRaster,
  loadWorkspaceIconRaster,
  pageMark,
  socialCardTitle,
  workspaceIconSeed,
  workspaceIconUrl,
  type SocialCardInput,
} from "@/lib/page-social-card";

const PAPER = "#F6F5F1";
const INK = "#1C1917";
const PAGE = "#FFFFFF";
const RULE = "#D6D3D1";

function Landmark({ seed, size }: { seed: number; size: number }) {
  const { background, cells } = pixelLandmarkGrid(seed);
  const cell = size / 9;
  return (
    <div
      style={{
        width: size,
        height: size,
        background,
        borderRadius: size * 0.18,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {cells.map((row, y) => (
        <div key={y} style={{ display: "flex", flexDirection: "row", width: size, height: cell }}>
          {row.map((color, x) => (
            <div key={x} style={{ width: cell, height: cell, background: color ?? "transparent" }} />
          ))}
        </div>
      ))}
    </div>
  );
}

function PageGlyph() {
  return (
    <div
      style={{
        width: 280,
        height: 280,
        borderRadius: 56,
        background: PAGE,
        border: `2px solid ${RULE}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: 132,
          height: 164,
          borderRadius: 16,
          background: "#E7E5E4",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "28px 22px",
          gap: 14,
        }}
      >
        <div style={{ height: 10, borderRadius: 6, background: "#A8A29E", display: "flex" }} />
        <div style={{ height: 10, borderRadius: 6, background: "#A8A29E", display: "flex" }} />
        <div style={{ height: 10, width: 56, borderRadius: 6, background: "#A8A29E", display: "flex" }} />
      </div>
    </div>
  );
}

/** PNG response. A missing page still draws a card, so the product icon is not the fallback. */
export async function renderPageSocialImage(page: SocialCardInput | null): Promise<ImageResponse> {
  const title = socialCardTitle(page?.title);
  const mark = pageMark(page?.icon);
  const pictureUrl = workspaceIconUrl(page);
  const [picture, emojiImages] = await Promise.all([
    pictureUrl ? loadWorkspaceIconRaster(pictureUrl) : Promise.resolve(null),
    mark.kind === "emoji"
      ? Promise.all(emojiGraphemes(mark.emoji).slice(0, 3).map((grapheme) => loadEmojiRaster(grapheme)))
      : Promise.resolve([] as (string | null)[]),
  ]);
  const emojis = emojiImages.filter((src): src is string => Boolean(src));
  const seed = workspaceIconSeed(page);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: PAPER,
          padding: "88px 80px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 56 }}>
          {picture ? (
            <img
              src={picture}
              width={280}
              height={280}
              style={{ borderRadius: 56, objectFit: "cover" }}
            />
          ) : (
            <Landmark seed={seed} size={280} />
          )}
          {emojis.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 12 }}>
              {emojis.map((src, index) => (
                <img key={index} src={src} width={240} height={240} />
              ))}
            </div>
          ) : (
            <PageGlyph />
          )}
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 72,
            width: 1000,
            justifyContent: "center",
            textAlign: "center",
            fontSize: 96,
            fontWeight: 700,
            lineHeight: 1.15,
            letterSpacing: "-0.03em",
            color: INK,
          }}
        >
          {title}
        </div>
      </div>
    ),
    {
      ...SOCIAL_IMAGE_SIZE,
      headers: { "cache-control": "public, max-age=60" },
    },
  );
}
