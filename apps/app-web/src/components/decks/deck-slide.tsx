"use client";

/**
 * Deck slide renderer — draws ONE slide from the SHARED layout engine's
 * primitive display list (`@use-brian/shared/decks`). Parity by
 * construction: this file maps primitives to absolutely-positioned
 * HTML/SVG and contains NO layout math — the same display list drives the
 * .pptx writer in core, so what this shows is what the file contains.
 * DOM order = paint order = pptx z-order (each shape is its own element).
 *
 * Units: primitives are in inches on a 13.33 x 7.5 page; `widthPx` sets the
 * scale (px per inch = widthPx / 13.33). Font pt -> px via scale / 72.
 * Text wrapping is the one acknowledged approximation (pptx `fit: shrink`
 * vs CSS) - mimicked with overflow-hidden at matching font sizes.
 *
 * Spec: docs/architecture/features/deck-generation.md -> "Live preview".
 * [COMP:app-web/decks]
 */

import { useEffect, useState, type CSSProperties } from "react";
import {
  DECK_PAGE_H,
  DECK_PAGE_W,
  type DeckBox,
  type DeckPrimitive,
  type DeckSlideLayout,
} from "@use-brian/shared/decks";
import { resolveDocFileSrc } from "@/components/doc/doc-file-url";

export function deckSlideHeightPx(widthPx: number): number {
  return (widthPx * DECK_PAGE_H) / DECK_PAGE_W;
}

function hex(color: string): string {
  return `#${color}`;
}

function fontStack(face: string): string {
  return `"${face}", Arial, ui-sans-serif, sans-serif`;
}

export function DeckSlide({
  layout,
  widthPx,
  workspaceId,
  className,
}: {
  layout: DeckSlideLayout;
  widthPx: number;
  workspaceId: string;
  className?: string;
}) {
  const scale = widthPx / DECK_PAGE_W; // px per inch
  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: widthPx,
        height: deckSlideHeightPx(widthPx),
        background: hex(layout.background),
        overflow: "hidden",
      }}
    >
      {layout.primitives.map((p, i) => (
        <Primitive key={i} p={p} scale={scale} workspaceId={workspaceId} />
      ))}
    </div>
  );
}

/**
 * `<img>` over a durable `workspace_files` doc file. The doc-files read
 * route is Bearer-only — its URL 401s as a plain `<img src>` — so the src
 * is the short-lived signed storage URL from the authenticated
 * `resolveDocFileSrc` mint, resolved per mount. Nothing renders while the
 * mint is in flight or after a failure (a deck image has no fallback box).
 */
function DocFileImage({
  workspaceId,
  fileId,
  style,
}: {
  workspaceId: string;
  fileId: string;
  style: CSSProperties;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    resolveDocFileSrc(workspaceId, fileId).then(
      (url) => {
        if (!cancelled) setSrc(url);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId, fileId]);
  if (!src) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" style={style} />;
}

function boxStyle(box: DeckBox, scale: number): CSSProperties {
  return {
    position: "absolute",
    left: box.x * scale,
    top: box.y * scale,
    width: box.w * scale,
    height: box.h * scale,
  };
}

function Primitive({
  p,
  scale,
  workspaceId,
}: {
  p: DeckPrimitive;
  scale: number;
  workspaceId: string;
}) {
  switch (p.kind) {
    case "rect":
      return (
        <div
          style={{
            ...boxStyle(p.box, scale),
            background: hex(p.fill),
            borderRadius: p.radiusIn ? p.radiusIn * scale : undefined,
          }}
        />
      );
    case "text":
      return <TextPrimitive p={p} scale={scale} />;
    case "lineSeg": {
      const x = Math.min(p.x1, p.x2) * scale;
      const y = Math.min(p.y1, p.y2) * scale;
      const w = Math.max(Math.abs(p.x2 - p.x1) * scale, 1);
      const h = Math.max(Math.abs(p.y2 - p.y1) * scale, 1);
      const strokePx = Math.max((p.widthPt / 72) * scale, 1);
      return (
        <svg
          style={{ position: "absolute", left: x - strokePx, top: y - strokePx, overflow: "visible" }}
          width={w + strokePx * 2}
          height={h + strokePx * 2}
          aria-hidden
        >
          <line
            x1={p.x1 * scale - x + strokePx}
            y1={p.y1 * scale - y + strokePx}
            x2={p.x2 * scale - x + strokePx}
            y2={p.y2 * scale - y + strokePx}
            stroke={hex(p.color)}
            strokeWidth={strokePx}
          />
        </svg>
      );
    }
    case "ellipse": {
      const s = boxStyle(p.box, scale);
      const strokePx = p.outline ? Math.max((p.outline.widthPt / 72) * scale, 1) : 0;
      return (
        <svg style={{ ...s, overflow: "visible" }} width={Number(s.width)} height={Number(s.height)} aria-hidden>
          <ellipse
            cx={Number(s.width) / 2}
            cy={Number(s.height) / 2}
            rx={Math.max(Number(s.width) / 2 - strokePx / 2, 0.5)}
            ry={Math.max(Number(s.height) / 2 - strokePx / 2, 0.5)}
            fill={hex(p.fill)}
            stroke={p.outline ? hex(p.outline.color) : undefined}
            strokeWidth={strokePx || undefined}
          />
        </svg>
      );
    }
    case "pieArc": {
      const s = boxStyle(p.box, scale);
      const w = Number(s.width);
      const h = Number(s.height);
      return (
        <svg style={s} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
          <path
            d={arcPath(w, h, p.startDeg, p.sweepDeg, p.thicknessRatio)}
            fill={hex(p.fill)}
            stroke={hex(p.outline.color)}
            strokeWidth={Math.max((p.outline.widthPt / 72) * scale, 1)}
          />
        </svg>
      );
    }
    case "image": {
      const style: CSSProperties = { ...boxStyle(p.frame, scale), objectFit: "contain" };
      if (p.source.url) {
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.source.url} alt="" style={style} />
        );
      }
      if (p.source.path) {
        return (
          <DocFileImage workspaceId={workspaceId} fileId={p.source.path} style={style} />
        );
      }
      return null;
    }
    default:
      return null;
  }
}

function TextPrimitive({
  p,
  scale,
}: {
  p: Extract<DeckPrimitive, { kind: "text" }>;
  scale: number;
}) {
  const fontPx = (p.fontSizePt / 72) * scale;
  const justify =
    p.valign === "middle" ? "center" : p.valign === "bottom" ? "flex-end" : "flex-start";
  return (
    <div
      style={{
        ...boxStyle(p.box, scale),
        display: "flex",
        flexDirection: "column",
        justifyContent: justify,
        textAlign: p.align,
        fontFamily: fontStack(p.fontFace),
        fontSize: fontPx,
        lineHeight: p.lineSpacingMultiple ?? 1.2,
        overflow: "hidden",
      }}
    >
      {p.paragraphs.map((para, i) => (
        <div
          key={i}
          style={{
            marginBottom: p.paraSpaceAfterPt && i < p.paragraphs.length - 1 ? (p.paraSpaceAfterPt / 72) * scale : undefined,
            paddingLeft: para.bullet ? fontPx * 1.1 : undefined,
            textIndent: para.bullet ? -fontPx * 1.1 : undefined,
          }}
        >
          {para.bullet ? "•  " : null}
          {para.runs.map((run, j) => (
            <span
              key={j}
              style={{
                color: hex(run.color),
                fontWeight: run.bold ? 700 : undefined,
                fontStyle: run.italic ? "italic" : undefined,
                whiteSpace: "pre-wrap",
              }}
            >
              {run.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Annular/pie sector path. pptx angle convention: 0 deg = 3 o'clock,
 * increasing CLOCKWISE - which matches SVG screen coords (y down), so the
 * plain cos/sin parameterization sweeps the right way.
 */
function arcPath(
  w: number,
  h: number,
  startDeg: number,
  sweepDeg: number,
  thicknessRatio?: number,
): string {
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const sweep = Math.min(sweepDeg, 359.999);
  const endDeg = startDeg + sweep;
  const large = sweep > 180 ? 1 : 0;
  const pt = (deg: number, kx: number, ky: number) => {
    const rad = (deg * Math.PI) / 180;
    return `${cx + kx * Math.cos(rad)} ${cy + ky * Math.sin(rad)}`;
  };
  if (thicknessRatio === undefined) {
    return `M ${cx} ${cy} L ${pt(startDeg, rx, ry)} A ${rx} ${ry} 0 ${large} 1 ${pt(endDeg, rx, ry)} Z`;
  }
  const irx = rx * (1 - thicknessRatio);
  const iry = ry * (1 - thicknessRatio);
  return (
    `M ${pt(startDeg, rx, ry)} A ${rx} ${ry} 0 ${large} 1 ${pt(endDeg, rx, ry)} ` +
    `L ${pt(endDeg, irx, iry)} A ${irx} ${iry} 0 ${large} 0 ${pt(startDeg, irx, iry)} Z`
  );
}
