// Buyer navigation and local conversation history; never starts inference or payments.
import { Plus } from '@phosphor-icons/react';

import { CHAT_STORAGE_STATE, type ChatArchiveState } from '../constants';
import type { ChatController } from './chat-controller';
import { MAIN_NAV, SIDEBAR_ACTION, UI_VIEW } from './constants';
import { ConversationHistory } from './ConversationHistory';
import type { View } from './model-types';
import { ServiceLogo } from './ServiceLogo';
import { SidebarActionIcon } from './SidebarActionIcon';
import { SidebarIcon } from './SidebarIcon';
import { Button, IconButton } from './UI';

type Props = {
  view: View;
  collapsed: boolean;
  chat: ChatController;
  storageState: ChatArchiveState;
  navigate: (view: View) => void;
  onNewChat: () => void;
  onOpenChat: (id: string) => void;
};

function NavigationItem({
  item,
  view,
  navigate,
}: {
  item: (typeof MAIN_NAV)[number];
  view: View;
  navigate: Props['navigate'];
}) {
  return (
    <IconButton
      className="preview-rail-item"
      title={item.label}
      label={item.label}
      aria-current={view === item.name ? 'page' : undefined}
      onClick={() => navigate(item.name)}
    >
      {item.name === UI_VIEW.CONNECT ? (
        <SidebarActionIcon kind={SIDEBAR_ACTION.LINK} />
      ) : item.name === UI_VIEW.PAYMENTS ? (
        <SidebarActionIcon kind={SIDEBAR_ACTION.WALLET} />
      ) : item.name === UI_VIEW.TOOLS ? (
        <SidebarActionIcon kind={SIDEBAR_ACTION.TOOLS} />
      ) : (
        <SidebarIcon name={item.name} />
      )}
    </IconButton>
  );
}

function ConversationList({
  chat,
  view,
  onOpenChat,
  storageState,
  collapsed,
  onNewChat,
  navigate,
}: Pick<
  Props,
  | 'chat'
  | 'view'
  | 'onOpenChat'
  | 'storageState'
  | 'collapsed'
  | 'onNewChat'
  | 'navigate'
>) {
  const loading = storageState === CHAT_STORAGE_STATE.LOADING;
  return (
    <section
      className="preview-chat-panel"
      aria-label="Conversation history"
      inert={collapsed}
      aria-hidden={collapsed || undefined}
    >
      <Button
        className="ui-nav-row preview-new-chat"
        disabled={loading}
        onClick={onNewChat}
      >
        <Plus size={16} />
        <span>New chat</span>
      </Button>
      <Button
        className="ui-nav-row preview-agents-entry"
        onClick={() => navigate(UI_VIEW.CONNECT)}
      >
        <span className="preview-connect-logos" aria-hidden="true">
          {['OpenCode', 'Codex', 'Claude Code', 'Pi'].map((tool) => (
            <span className="preview-tool-logo" key={tool}>
              <ServiceLogo service={tool} />
            </span>
          ))}
        </span>
        <span>Connect agents</span>
      </Button>
      <ConversationHistory
        chat={chat}
        chatVisible={view === UI_VIEW.CHAT}
        loading={loading}
        open={onOpenChat}
      />
    </section>
  );
}

export function BuyerSidebar(props: Props) {
  return (
    <aside id="app-sidebar" className="sidebar buyer-sidebar">
      <nav aria-label="Main navigation" className="preview-rail">
        {MAIN_NAV.filter((item) => item.name !== UI_VIEW.ACTIVITY).map(
          (item) => (
            <NavigationItem
              key={item.name}
              item={item}
              view={props.view}
              navigate={props.navigate}
            />
          ),
        )}
        <span className="preview-rail-spacer" />
        <IconButton
          label="Settings"
          className="preview-rail-item"
          aria-current={props.view === UI_VIEW.SETTINGS ? 'page' : undefined}
          onClick={() => props.navigate(UI_VIEW.SETTINGS)}
        >
          <SidebarActionIcon kind={SIDEBAR_ACTION.SETTINGS} />
        </IconButton>
      </nav>
      <ConversationList {...props} />
    </aside>
  );
}
