/**
 * `next/image` shim → plain `<img>` (no optimization server on file://).
 * Aliased in vite.desktop.config.ts. Next-only props are dropped; layout props
 * (width/height/className/style/alt/src) pass through. `fill` maps to an
 * absolutely-positioned, 100%-sized image to match Next's `fill` behavior.
 */
import type { CSSProperties, ImgHTMLAttributes } from "react";

type NextImageProps = {
  src: string | { src: string };
  alt?: string;
  width?: number | string;
  height?: number | string;
  fill?: boolean;
  priority?: boolean;
  quality?: number;
  placeholder?: string;
  loader?: unknown;
  unoptimized?: boolean;
  style?: CSSProperties;
} & Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt" | "width" | "height" | "style">;

export default function Image({
  src,
  alt,
  width,
  height,
  fill,
  priority: _priority,
  quality: _quality,
  placeholder: _placeholder,
  loader: _loader,
  unoptimized: _unoptimized,
  style,
  ...rest
}: NextImageProps) {
  const resolved = typeof src === "string" ? src : src?.src;
  const fillStyle: CSSProperties = fill
    ? { position: "absolute", inset: 0, width: "100%", height: "100%", ...style }
    : style ?? {};
  return (
    <img
      src={resolved}
      alt={alt ?? ""}
      width={fill ? undefined : width}
      height={fill ? undefined : height}
      style={fillStyle}
      {...rest}
    />
  );
}
