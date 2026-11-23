// Shared window header. Navigation and panel actions never invoke inference or payment services.
import {
  ArrowLeft,
  ArrowRight,
  Info,
  SidebarSimple,
} from '@phosphor-icons/react';
import {
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { WINDOW_PLATFORM } from '../constants';
import { windowPlatform } from '../window-chrome';
import type { ChatController } from './chat-controller';
import { MAIN_NAV, UI_VIEW } from './constants';
import { ConversationMenu } from './ConversationMenu';
import type { View } from './model-types';
import type { Navigation } from './navigation-state';
import { IconButton } from './UI';

type Props = {
  route: Navigation;
  chat: ChatController;
  onNewChat(): void;
  collapsed: boolean;
  contextOpen: boolean;
  onSidebar: () => void;
  onBack: () => void;
  onForward: () => void;
  onContext: () => void;
  notify(message: string): void;
  children?: ReactNode;
};
function screenLabel(view: View | undefined) {
  return MAIN_NAV.find((item) => item.name === view)?.label ?? view;
}
function useTitleBounds() {
  const header = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = header.current;
    const leading = element?.querySelector('.ui-window-leading');
    const trailing = element?.querySelector('.top-actions');
    if (!element || !leading || !trailing) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      const gap = parseFloat(getComputedStyle(element).columnGap) || 0;
      const inset =
        Math.max(
          leading.getBoundingClientRect().right - bounds.left,
          bounds.right - trailing.getBoundingClientRect().left,
        ) + gap;
      element.style.setProperty('--window-title-inset', inset + 'px');
    };
    const observer = new ResizeObserver(measure);
    for (const target of [element, leading, trailing]) observer.observe(target);
    measure();
    return () => observer.disconnect();
  }, []);
  return header;
}
function PaymentNetworkLabel() {
  return (
    <div
      className="preview-network"
      role="group"
      aria-label="USDC payment network"
    >
      <span className="preview-network-single" data-network="testnet">
        <span className="preview-network-dot" aria-hidden="true" />
        Testnet
      </span>
      <button
        type="button"
        disabled
        data-network="mainnet"
        title="Mainnet is unavailable"
      >
        Mainnet
      </button>
    </div>
  );
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
  const header = useTitleBounds();
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
      ref={header}
      className="topbar ui-window-chrome"
      data-platform={platform}
      data-route={props.route.current}
    >
      <WindowNavigation {...props} />
      <h1 id="route-title" className="ui-window-title">
        {title}
      </h1>
      <div className="top-actions">
        <PaymentNetworkLabel />
        {props.route.current === UI_VIEW.CHAT && (
          <ConversationMenu
            onNewChat={props.onNewChat}
            chat={props.chat}
            notify={props.notify}
          />
        )}
        {props.children}
        {(props.route.current === UI_VIEW.CONNECT ||
          props.route.current === UI_VIEW.CHAT) && (
          <IconButton
            label={
              props.route.current === UI_VIEW.CHAT
                ? props.contextOpen
                  ? 'Hide conversation details'
                  : 'Show conversation details'
                : props.contextOpen
                  ? 'Hide connection context'
                  : 'Show connection context'
            }
            id={
              props.route.current === UI_VIEW.CHAT
                ? 'chat-details-toggle'
                : undefined
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
