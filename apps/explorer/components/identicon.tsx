import { sellerFace } from '../lib/seller-identity';

const COLORS = ['#b7e577', '#b5a2f6', '#f0b97b', '#8cd0ce'] as const;
const MOUTHS = [
  'M11 18q3 4 6 0',
  'M12 19q3 1 5-2',
  'M12 18.5h4',
  'M12 18h4q0 4-4 0z',
] as const;

export function Identicon({ nodeId }: { nodeId: string }) {
  const face = sellerFace(nodeId);
  const color = COLORS[face.color];
  return (
    <span
      className="seller-avatar"
      aria-hidden="true"
      style={{ backgroundColor: color }}
    >
      <svg width="26" height="26" viewBox="0 0 28 28" fill="none">
        <g stroke="#242532" strokeWidth="2" strokeLinecap="round">
          {face.antenna ? (
            <path d="m14 9 2-5" />
          ) : (
            <path d="m8 10-2-4m14 4 2-4" />
          )}
        </g>
        <rect x="2" y="13" width="24" height="5" rx="2.5" fill="#454452" />
        <rect
          x="4"
          y="8"
          width="20"
          height="15"
          rx={face.antenna ? 6 : 4}
          fill="#242532"
        />
        {face.wink ? (
          <path
            d="m8 14 1.5-1 1.5 1"
            stroke="white"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        ) : (
          <rect x="8" y="11.5" width="3.5" height="4.5" rx="1.6" fill="white" />
        )}
        <rect
          x="16.5"
          y="11.5"
          width="3.5"
          height="4.5"
          rx="1.6"
          fill="white"
        />
        <path
          d={MOUTHS[face.mouth]}
          stroke={color}
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
