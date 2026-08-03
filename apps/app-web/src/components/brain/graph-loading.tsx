import { Skeleton } from "@/components/skeleton";

type GraphSkeletonNode = {
  x: number;
  y: number;
  radius: number;
  labelWidth: number;
  hub?: boolean;
};

// A settled force-graph composition whose outer nodes form a brain silhouette.
// The asymmetry is deliberate: real d3 layouts settle into clusters, not a
// perfectly mirrored diagram.
const GRAPH_NODES: GraphSkeletonNode[] = [
  { x: 360, y: 218, radius: 12, labelWidth: 70, hub: true },
  { x: 292, y: 144, radius: 9, labelWidth: 54, hub: true },
  { x: 429, y: 147, radius: 9, labelWidth: 58, hub: true },
  { x: 330, y: 70, radius: 7, labelWidth: 42 },
  { x: 394, y: 78, radius: 6, labelWidth: 36 },
  { x: 194, y: 105, radius: 9, labelWidth: 62, hub: true },
  { x: 527, y: 109, radius: 8, labelWidth: 56 },
  { x: 253, y: 216, radius: 8, labelWidth: 48 },
  { x: 469, y: 213, radius: 8, labelWidth: 50 },
  { x: 112, y: 215, radius: 10, labelWidth: 68, hub: true },
  { x: 607, y: 220, radius: 9, labelWidth: 64, hub: true },
  { x: 282, y: 300, radius: 8, labelWidth: 52 },
  { x: 440, y: 299, radius: 8, labelWidth: 54 },
  { x: 155, y: 308, radius: 8, labelWidth: 60 },
  { x: 563, y: 314, radius: 7, labelWidth: 56 },
  { x: 224, y: 378, radius: 7, labelWidth: 48 },
  { x: 496, y: 380, radius: 7, labelWidth: 48 },
  { x: 320, y: 371, radius: 6, labelWidth: 38 },
  { x: 404, y: 376, radius: 6, labelWidth: 40 },
];

const GRAPH_EDGES: Array<[number, number]> = [
  // Central bridges.
  [0, 1], [0, 2], [0, 7], [0, 8], [0, 11], [0, 12], [0, 17], [0, 18],
  [1, 2], [11, 12],
  // Left-side communities.
  [1, 3], [1, 5], [1, 7], [3, 4], [3, 5], [5, 7], [5, 9], [7, 9],
  [7, 11], [9, 13], [11, 13], [11, 15], [11, 17], [13, 15], [15, 17],
  // Right-side communities.
  [2, 4], [2, 6], [2, 8], [4, 6], [6, 8], [6, 10], [8, 10], [8, 12],
  [10, 14], [12, 14], [12, 16], [12, 18], [14, 16], [16, 18],
];

const SKELETON_COLOR =
  "color-mix(in srgb, var(--muted-foreground) 12%, transparent)";

/**
 * String-free, server-renderable loading illustration shared by the Brain
 * route fallback and the live graph fetch. It mirrors the finished canvas's
 * circles, labels, edges, and clustered layout using only skeleton color.
 */
export function BrainGraphLoadingSkeleton() {
  return (
    <div
      aria-hidden="true"
      data-brain-graph-skeleton="true"
      className="absolute inset-0 overflow-hidden bg-[var(--graph-bg)]"
    >
      <svg
        viewBox="0 0 720 440"
        preserveAspectRatio="xMidYMid meet"
        className="h-full w-full p-[6%]"
      >
        <g
          data-brain-graph-edges="true"
          fill="none"
          stroke={SKELETON_COLOR}
          strokeLinecap="round"
          strokeWidth="2"
        >
          {GRAPH_EDGES.map(([from, to]) => {
            const source = GRAPH_NODES[from]!;
            const target = GRAPH_NODES[to]!;
            return (
              <line
                key={`${from}-${to}`}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
              />
            );
          })}
        </g>
        {GRAPH_NODES.map((node, index) => {
          const diameter = node.radius * 2;
          return (
            <foreignObject
              key={`${node.x}-${node.y}`}
              x={node.x - node.labelWidth / 2}
              y={node.y - node.radius}
              width={node.labelWidth}
              height={diameter + 11}
            >
              <div className="flex h-full w-full flex-col items-center">
                <Skeleton
                  data-brain-graph-node={node.hub ? "hub" : "node"}
                  className="shrink-0 rounded-full shadow-sm"
                  style={{ width: diameter, height: diameter }}
                />
                <Skeleton
                  data-brain-graph-label={index}
                  className="mt-[5px] h-1 w-full rounded-full"
                />
              </div>
            </foreignObject>
          );
        })}
      </svg>
    </div>
  );
}
