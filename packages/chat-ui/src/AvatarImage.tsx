"use client";

import { useCallback, useState, type ComponentProps, type ReactNode } from "react";

type AvatarImageProps = Pick<ComponentProps<"img">, "src" | "alt" | "width" | "height" | "style" | "className"> & {
  fallback: () => ReactNode;
};

/** Callers key the image by URL so a replacement starts with its fallback. */
export function AvatarImage({ fallback, style, ...image }: AvatarImageProps) {
  const [ready, setReady] = useState(false);
  const revealCachedImage = useCallback((element: HTMLImageElement | null) => {
    if (element?.complete && element.naturalWidth > 0) setReady(true);
  }, []);

  return (
    <>
      {!ready && fallback()}
      <img
        {...image}
        ref={revealCachedImage}
        style={ready ? style : { ...style, display: "none" }}
        onLoad={() => setReady(true)}
        onError={() => setReady(false)}
      />
    </>
  );
}
