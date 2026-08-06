"use client";

import type { PresentationSnapshot } from "@use-brian/office-model";
import { cn } from "@/lib/utils";
import { PresentationObjectVisual } from "./presentation-object-frame";

type PresentationSlide = PresentationSnapshot["slides"][number];

/** Read-only point-space slide projection shared by thumbnails and Present mode. */
export function PresentationSlideVisual({
  artifactId,
  slide,
  slideSize,
  className,
}: {
  artifactId: string;
  slide: PresentationSlide;
  slideSize: PresentationSnapshot["slideSize"];
  className?: string;
}) {
  return (
    <svg
      data-presentation-slide-visual="true"
      viewBox={`0 0 ${slideSize.widthPt} ${slideSize.heightPt}`}
      preserveAspectRatio="xMidYMid meet"
      className={cn("block", className)}
    >
      <rect width={slideSize.widthPt} height={slideSize.heightPt} fill="#FFFFFF" />
      {slide.objects.map((object) => {
        const { xPt, yPt, widthPt, heightPt, rotationDeg } = object.geometry;
        const centerX = xPt + widthPt / 2;
        const centerY = yPt + heightPt / 2;
        return (
          <foreignObject
            key={object.id}
            x={xPt}
            y={yPt}
            width={widthPt}
            height={heightPt}
            transform={rotationDeg ? `rotate(${rotationDeg} ${centerX} ${centerY})` : undefined}
            overflow="hidden"
          >
            <div className="h-full w-full overflow-hidden">
              <PresentationObjectVisual artifactId={artifactId} object={object} slideSize={slideSize} renderScale="points" />
            </div>
          </foreignObject>
        );
      })}
    </svg>
  );
}
