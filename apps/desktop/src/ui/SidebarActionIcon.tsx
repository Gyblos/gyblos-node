// Decorative sidebar choreography moves meaningful icon parts without changing the hit target.
import {
  ChatCircle,
  GearSix,
  Heartbeat,
  Link,
  MagnifyingGlass,
  Plus,
  SidebarSimple,
  Wallet,
  Wrench,
  X,
} from '@phosphor-icons/react';
import { useId, type ReactNode } from 'react';

import { SIDEBAR_ACTION, SIDEBAR_TYPING_POSITIONS } from './constants';

const GLYPHS = {
  [SIDEBAR_ACTION.CREATE]: Plus,
  [SIDEBAR_ACTION.CLEAR]: X,
  [SIDEBAR_ACTION.PANEL]: SidebarSimple,
  [SIDEBAR_ACTION.STATUS]: Heartbeat,
  [SIDEBAR_ACTION.SETTINGS]: GearSix,
  [SIDEBAR_ACTION.WALLET]: Wallet,
  [SIDEBAR_ACTION.TOOLS]: Wrench,
  [SIDEBAR_ACTION.LINK]: Link,
  [SIDEBAR_ACTION.CHAT]: ChatCircle,
  [SIDEBAR_ACTION.SEARCH]: MagnifyingGlass,
};
type Kind = keyof typeof GLYPHS;
function WalletParts({ id, artwork }: { id: string; artwork: ReactNode }) {
  return (
    <>
      <defs>
        <clipPath id={id + '-lid'}>
          <rect width="256" height="80" />
        </clipPath>
        <clipPath id={id + '-body'}>
          <rect y="80" width="256" height="176" />
        </clipPath>
      </defs>
      <g clipPath={'url(#' + id + '-body)'}>{artwork}</g>
      <g className="sidebar-wallet-lid">
        <g clipPath={'url(#' + id + '-lid)'}>{artwork}</g>
      </g>
      <circle
        className="sidebar-wallet-coin"
        cx="148"
        cy="80"
        r="13"
        fill="none"
        stroke="currentColor"
        strokeWidth="12"
      />
    </>
  );
}
function PanelParts({ id, artwork }: { id: string; artwork: ReactNode }) {
  return (
    <>
      <defs>
        <mask
          id={id + '-frame'}
          maskUnits="userSpaceOnUse"
          width="256"
          height="256"
        >
          <rect width="256" height="256" fill="white" />
          <rect x="80" y="56" width="16" height="144" fill="black" />
        </mask>
        <clipPath id={id + '-divider'}>
          <rect x="80" y="56" width="16" height="144" />
        </clipPath>
      </defs>
      <g mask={'url(#' + id + '-frame)'}>{artwork}</g>
      <g
        className="sidebar-panel-divider"
        clipPath={'url(#' + id + '-divider)'}
      >
        {artwork}
      </g>
    </>
  );
}
function IconParts({
  kind,
  id,
  artwork,
}: {
  kind: Kind;
  id: string;
  artwork: ReactNode;
}) {
  if (kind === SIDEBAR_ACTION.WALLET)
    return <WalletParts id={id} artwork={artwork} />;
  if (kind === SIDEBAR_ACTION.PANEL)
    return <PanelParts id={id} artwork={artwork} />;
  if (kind === SIDEBAR_ACTION.CREATE || kind === SIDEBAR_ACTION.CLEAR)
    return (
      <CreateParts
        id={id}
        artwork={artwork}
        clear={kind === SIDEBAR_ACTION.CLEAR}
      />
    );
  if (kind === SIDEBAR_ACTION.LINK)
    return (
      <>
        <defs>
          <clipPath id={id + '-upper'}>
            <polygon points="0,0 256,0 256,256" />
          </clipPath>
          <clipPath id={id + '-lower'}>
            <polygon points="0,0 0,256 256,256" />
          </clipPath>
        </defs>
        <g className="sidebar-link-upper">
          <g clipPath={'url(#' + id + '-upper)'}>{artwork}</g>
        </g>
        <g className="sidebar-link-lower">
          <g clipPath={'url(#' + id + '-lower)'}>{artwork}</g>
        </g>
      </>
    );
  if (kind === SIDEBAR_ACTION.CHAT)
    return (
      <>
        {artwork}
        {SIDEBAR_TYPING_POSITIONS.map((cx, index) => (
          <circle
            key={cx}
            className={'sidebar-chat-dot sidebar-chat-dot-' + index}
            cx={cx}
            cy="124"
            r="9"
            fill="currentColor"
          />
        ))}
      </>
    );
  if (kind === SIDEBAR_ACTION.STATUS)
    return (
      <>
        <defs>
          <clipPath id={id}>
            <rect className="sidebar-status-scan" width="256" height="256" />
          </clipPath>
        </defs>
        <g clipPath={'url(#' + id + ')'}>{artwork}</g>
      </>
    );
  return <g className={'sidebar-' + kind + '-part'}>{artwork}</g>;
}
export function SidebarActionIcon({ kind }: { kind: Kind }) {
  const id = useId().replaceAll(':', '');
  const Glyph = GLYPHS[kind];
  return (
    <svg
      viewBox="0 0 256 256"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
      data-sidebar-motion={kind}
    >
      <IconParts
        kind={kind}
        id={id}
        artwork={<Glyph size={256} aria-hidden="true" />}
      />
    </svg>
  );
}

function CreateParts({
  clear = false,
  id,
  artwork,
}: {
  clear?: boolean;
  id: string;
  artwork: ReactNode;
}) {
  return (
    <>
      <defs>
        <mask id={id} maskUnits="userSpaceOnUse" width="256" height="256">
          <rect
            className="sidebar-create-rest"
            width="256"
            height="256"
            fill="white"
          />
          <g stroke="white" strokeWidth="24" strokeLinecap="round">
            <path
              className="sidebar-create-horizontal"
              d={clear ? 'M48 48L208 208' : 'M32 128H224'}
              pathLength="1"
            />
            <path
              className="sidebar-create-vertical"
              d={clear ? 'M208 48L48 208' : 'M128 32V224'}
              pathLength="1"
            />
          </g>
        </mask>
      </defs>
      <g mask={'url(#' + id + ')'}>{artwork}</g>
    </>
  );
}
