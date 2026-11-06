// Resolves the sidebar's finite icon catalog into decorative SVGs. Visible group titles own labels;
// metadata never selects arbitrary components, scripts or remote assets.
import { SIDEBAR_ICON_IDS } from '../lib/constants';

function paths(name: string) {
  switch (name) {
    case SIDEBAR_ICON_IDS.COMPASS:
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m16 8-2.5 5.5L8 16l2.5-5.5Z" />
        </>
      );
    case SIDEBAR_ICON_IDS.SERVER:
      return (
        <>
          <rect x="3" y="3" width="18" height="7" rx="2" />
          <rect x="3" y="14" width="18" height="7" rx="2" />
          <path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6" />
        </>
      );
    case SIDEBAR_ICON_IDS.BOOK_OPEN:
      return (
        <path d="M12 5v16M12 5C9 2 5 2 2 4v15c3-2 7-2 10 2 3-4 7-4 10-2V4c-3-2-7-2-10 1Z" />
      );
    case SIDEBAR_ICON_IDS.LIFE_BUOY:
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="4" />
          <path d="m5.6 5.6 3.6 3.6m5.6 5.6 3.6 3.6m0-12.8-3.6 3.6m-5.6 5.6-3.6 3.6" />
        </>
      );
  }
}

export function sidebarIcon(name: string | undefined) {
  if (!name) return undefined;
  const content = paths(name);
  if (!content) return undefined;
  return (
    <svg
      data-sidebar-icon={name}
      className="docs-sidebar-icon"
      aria-hidden="true"
      focusable="false"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {content}
    </svg>
  );
}
