// Animates meaningful parts of the existing Phosphor SVG navigation icons.
// Keeps artwork local and decorative; buttons own labels, focus and navigation.
import {
  ChartLineUp,
  ChatCircle,
  Globe,
  PlugsConnected,
  Wallet,
  Wrench,
} from '@phosphor-icons/react';
import { useId, type ReactNode } from 'react';

import { UI_VIEW } from './constants';

const GLYPHS = {
  [UI_VIEW.CHAT]: ChatCircle,
  [UI_VIEW.TOOLS]: Wrench,
  [UI_VIEW.MODELS]: Globe,
  [UI_VIEW.CONNECT]: PlugsConnected,
  [UI_VIEW.ACTIVITY]: ChartLineUp,
  [UI_VIEW.PAYMENTS]: Wallet,
};
export type SidebarSection = keyof typeof GLYPHS;

export function SidebarIcon({ name }: { name: SidebarSection }) {
  const id = useId().replaceAll(':', '');
  const Glyph = GLYPHS[name];
  const artwork = (
    <Glyph size={256} weight="regular" aria-hidden="true" focusable="false" />
  );
  return (
    <svg
      className={'nav-glyph nav-glyph--' + name}
      data-sidebar-motion={name}
      viewBox="0 0 256 256"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      {name === UI_VIEW.MODELS ? (
        <GlobeParts id={id} artwork={artwork} />
      ) : name === UI_VIEW.ACTIVITY ? (
        <ChartParts id={id} artwork={artwork} />
      ) : (
        artwork
      )}
    </svg>
  );
}
function GlobeParts({ id, artwork }: { id: string; artwork: ReactNode }) {
  return (
    <>
      {' '}
      <defs>
        <mask
          id={`${id}-globe-build`}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="256"
          height="256"
        >
          <rect className="globe-rest" width="256" height="256" fill="white" />
          <g fill="none" stroke="white" strokeWidth="26" strokeLinecap="round">
            <circle
              className="globe-trace globe-trace--outline"
              cx="128"
              cy="128"
              r="96"
              pathLength="1"
            />
            <path
              className="globe-trace globe-trace--latitude"
              d="M40 96H216 M40 160H216"
              pathLength="1"
            />
            <path
              className="globe-trace globe-trace--meridian"
              d="M128 32C65 88 65 168 128 224 M128 32C191 88 191 168 128 224"
              pathLength="1"
            />
          </g>
        </mask>
      </defs>
      <g mask={`url(#${id}-globe-build)`}>{artwork}</g>
    </>
  );
}
function ChartParts({ id, artwork }: { id: string; artwork: ReactNode }) {
  return (
    <>
      {' '}
      <defs>
        <mask
          id={`${id}-axis`}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="256"
          height="256"
        >
          <rect width="256" height="256" fill="white" />
          <rect x="64" y="16" width="184" height="180" fill="black" />
        </mask>
        <clipPath id={`${id}-chart`}>
          <rect x="64" y="16" width="184" height="180" />
        </clipPath>
      </defs>
      <g mask={`url(#${id}-axis)`}>{artwork}</g>
      <g clipPath={`url(#${id}-chart)`}>
        <g className="chart-trace">{artwork}</g>
      </g>
    </>
  );
}
