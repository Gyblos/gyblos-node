import { IDENTITY } from '../lib/constants';
import { identicon } from '../lib/seller-identity';

export function Identicon({ nodeId }: { nodeId: string }) {
  const size = IDENTITY.gridSize * IDENTITY.cellPx;
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox={`0 0 ${IDENTITY.gridSize} ${IDENTITY.gridSize}`}
      className="shrink-0 text-dim"
    >
      {identicon(nodeId).flatMap((row, y) =>
        row.map((filled, x) =>
          filled ? (
            <rect
              key={`${x}:${y}`}
              x={x}
              y={y}
              width={1}
              height={1}
              fill="currentColor"
            />
          ) : null,
        ),
      )}
    </svg>
  );
}
