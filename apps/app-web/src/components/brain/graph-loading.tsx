/**
 * String-free, server-renderable loading illustration shared by the Brain
 * route fallback and the live graph fetch. It sketches relationships and
 * communities instead of impersonating data with oversized skeleton blobs.
 */
export function GraphLoadingConstellation() {
  const nodes: Array<[number, number, "knowledge" | "person" | "company"]> = [
    [18, 31, "knowledge"], [25, 22, "knowledge"], [29, 37, "knowledge"],
    [36, 28, "knowledge"], [23, 47, "knowledge"], [39, 44, "knowledge"],
    [53, 23, "person"], [61, 17, "person"], [68, 28, "person"],
    [58, 35, "person"], [73, 40, "person"], [64, 49, "person"],
    [45, 61, "company"], [53, 70, "company"], [64, 66, "company"],
    [70, 77, "company"], [37, 76, "company"], [79, 61, "company"],
  ];
  const edges: Array<[number, number]> = [
    [0, 1], [0, 2], [0, 3], [1, 3], [2, 4], [2, 5], [3, 5],
    [6, 7], [6, 8], [6, 9], [8, 10], [9, 10], [9, 11], [10, 11],
    [12, 13], [12, 14], [12, 16], [13, 14], [13, 16], [14, 15],
    [14, 17], [15, 17], [3, 6], [5, 12], [11, 17],
  ];

  return (
    <div
      aria-hidden="true"
      className="brain-graph-loading absolute inset-0 overflow-hidden bg-[var(--graph-bg)]"
    >
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="xMidYMid slice"
        className="h-full w-full"
      >
        <g className="brain-graph-loading-edges">
          {edges.map(([from, to], index) => {
            const a = nodes[from]!;
            const b = nodes[to]!;
            return (
              <line
                key={`${from}-${to}`}
                x1={a[0]}
                y1={a[1]}
                x2={b[0]}
                y2={b[1]}
                style={{ animationDelay: `${index * -90}ms` }}
              />
            );
          })}
        </g>
        <g>
          {nodes.map(([x, y, kind], index) => (
            <g key={`${x}-${y}`} transform={`translate(${x} ${y})`}>
              <circle
                r={index % 6 === 0 ? 2.15 : index % 3 === 0 ? 1.55 : 1.15}
                className={`brain-graph-loading-node brain-graph-loading-node-${kind}`}
                style={{ animationDelay: `${index * -135}ms` }}
              />
              {index % 6 === 0 && (
                <circle
                  r="4.2"
                  className="brain-graph-loading-ring"
                  style={{ animationDelay: `${index * -240}ms` }}
                />
              )}
            </g>
          ))}
        </g>
      </svg>
      <span className="brain-graph-loading-scan" />
    </div>
  );
}
