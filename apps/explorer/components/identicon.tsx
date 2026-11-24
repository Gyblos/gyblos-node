import { sellerFace } from '../lib/seller-identity';

const COLORS = ['#b7e577', '#b5a2f6', '#f0b97b', '#8cd0ce'] as const;
const MOUTHS = [
  'M11 18v2h6v-2',
  'M12 20h4v-2h2',
  'M11 19h7',
  'M12 18h5v2h-5z',
] as const;

export function Identicon({ nodeId }: { nodeId: string }) {
  const face = sellerFace(nodeId);
  const color = COLORS[face.color];
  return (
    <span
      className="seller-avatar"
      aria-hidden="true"
      style={{
        backgroundColor: `color-mix(in srgb, ${color} 13%, var(--panel))`,
      }}
    >
      <svg
        width="26"
        height="26"
        viewBox="0 0 28 28"
        fill="none"
        stroke={color}
        strokeWidth="1.65"
        strokeLinejoin="round"
      >
        {face.antenna ? <path d="M14 7V4h4" /> : <path d="M10 7V5m8 2V5" />}
        <path d="M7 7h14v2h2v12h-2v2H7v-2H5V9h2z" />
        <g fill={color} stroke="none">
          <rect
            x="9"
            y={face.wink ? '13' : '11'}
            width="3"
            height={face.wink ? '2' : '4'}
            rx=".5"
          />
          <rect x="16" y="11" width="3" height="4" rx=".5" />
        </g>
        <path d={MOUTHS[face.mouth]} />
      </svg>
    </span>
  );
}
