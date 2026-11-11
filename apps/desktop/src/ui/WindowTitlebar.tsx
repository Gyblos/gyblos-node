// Shared window header. Navigation and panel actions never invoke inference or payment services.
import {
  ArrowLeft,
  ArrowRight,
  Info,
  SidebarSimple,
} from '@phosphor-icons/react';
import { useSyncExternalStore, type ReactNode } from 'react';

import { WINDOW_PLATFORM } from '../constants';
import { windowPlatform } from '../window-chrome';
import type { ChatController } from './chat-controller';
import { MAIN_NAV, UI_VIEW } from './constants';
import type { View } from './model-types';
import type { Navigation } from './navigation-state';
import { IconButton } from './UI';

type Props = {
  route: Navigation;
  chat: ChatController;
  collapsed: boolean;
  contextOpen: boolean;
  onSidebar: () => void;
  onBack: () => void;
  onForward: () => void;
  onContext: () => void;
  children?: ReactNode;
};
function screenLabel(view: View | undefined) {
  return MAIN_NAV.find((item) => item.name === view)?.label ?? view;
}
function WindowNavigation(props: Props) {
  const previous = props.route.history.at(-1);
  const next = props.route.future[0];
  return (
    <div className="ui-window-leading">
      <span className="ui-native-controls-space" aria-hidden="true" />
      <IconButton
        label={props.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-controls="app-sidebar"
        aria-expanded={!props.collapsed}
        onClick={props.onSidebar}
      >
        <SidebarSimple size={16} aria-hidden="true" />
      </IconButton>
      <nav className="ui-window-navigation" aria-label="Screen history">
        <IconButton
          label="Go back"
          aria-description={
            previous ? `Back to ${screenLabel(previous)}` : 'No previous screen'
          }
          disabled={!previous}
          onClick={props.onBack}
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Go forward"
          aria-description={
            next ? `Forward to ${screenLabel(next)}` : 'No next screen'
          }
          disabled={!next}
          onClick={props.onForward}
        >
          <ArrowRight size={16} aria-hidden="true" />
        </IconButton>
      </nav>
    </div>
  );
}
export function WindowTitlebar(props: Props) {
  const snapshot = useSyncExternalStore(
    props.chat.subscribe,
    props.chat.getSnapshot,
  );
  const conversation = snapshot.sessions.find(
    (item) => item.id === snapshot.activeId,
  );
  const title =
    props.route.current === UI_VIEW.CHAT
      ? conversation?.messages.length
        ? conversation.title
        : 'New chat'
      : screenLabel(props.route.current);
  const platform = windowPlatform(
    window.desktopWindow?.platform ?? WINDOW_PLATFORM.WEB,
  );
  return (
    <header
      className="topbar ui-window-chrome"
      data-platform={platform}
      data-route={props.route.current}
    >
      <WindowNavigation {...props} />
      <h1 id="route-title" className="ui-window-title">
        {title}
      </h1>
      <div className="top-actions">
        {props.children}
        {props.route.current === UI_VIEW.CONNECT && (
          <IconButton
            label={
              props.contextOpen
                ? 'Hide connection context'
                : 'Show connection context'
            }
            aria-pressed={props.contextOpen}
            onClick={props.onContext}
          >
            <Info size={16} aria-hidden="true" />
          </IconButton>
        )}
      </div>
    </header>
  );
}
