// Buyer navigation and local conversation history; never starts inference or payments.
import {
  ChatCircle,
  GearSix,
  Link,
  Plus,
  SidebarSimple,
} from '@phosphor-icons/react';
import { useState, useSyncExternalStore } from 'react';

import { CHAT_STORAGE_STATE, type ChatArchiveState } from '../constants';
import type { ChatController } from './chat-controller';
import { MAIN_NAV, UI_VIEW } from './constants';
import type { View } from './model-types';
import { SidebarIcon } from './SidebarIcon';
import { Badge, Button, IconButton, SearchField } from './UI';

type Props = {
  view: View;
  collapsed: boolean;
  chat: ChatController;
  storageState: ChatArchiveState;
  navigate: (view: View) => void;
  onNewChat: () => void;
  onOpenChat: (id: string) => void;
  onCollapse: () => void;
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
    <Button
      className="ui-nav-row"
      aria-current={view === item.name ? 'page' : undefined}
      onClick={() => navigate(item.name)}
    >
      {item.name === UI_VIEW.CONNECT ? (
        <Link size={20} />
      ) : (
        <SidebarIcon name={item.name} />
      )}
      <span>{item.label}</span>
      {item.name === UI_VIEW.CONNECT && <Badge>API</Badge>}
    </Button>
  );
}

function ConversationList({
  chat,
  view,
  onOpenChat,
  storageState,
}: Pick<Props, 'chat' | 'view' | 'onOpenChat' | 'storageState'>) {
  const { sessions, activeId } = useSyncExternalStore(
    chat.subscribe,
    chat.getSnapshot,
  );
  const [search, setSearch] = useState('');
  const loading = storageState === CHAT_STORAGE_STATE.LOADING;
  const history = sessions
    .map((session) => ({
      ...session,
      title: session.messages.length
        ? session.title
        : session.draft.trim() || session.title,
    }))
    .filter((session) => session.messages.length || session.draft.trim())
    .filter((session) =>
      session.title.toLowerCase().includes(search.trim().toLowerCase()),
    )
    .slice()
    .reverse();
  return (
    <section className="ui-sidebar-history" aria-label="Conversation history">
      <SearchField
        label="Search conversations"
        placeholder="Search conversations"
        value={search}
        onValueChange={setSearch}
      />
      <h2 className="ui-sidebar-section-title">Recent</h2>
      <div className="ui-sidebar-history-list">
        {history.map((session) => (
          <Button
            key={session.id}
            className="ui-nav-row"
            disabled={loading}
            aria-current={
              view === UI_VIEW.CHAT && activeId === session.id
                ? 'page'
                : undefined
            }
            onClick={() => onOpenChat(session.id)}
          >
            <ChatCircle size={18} />
            <span>{session.title}</span>
          </Button>
        ))}
        {!history.length && (
          <p className="ui-help-text">
            {loading
              ? 'Loading conversations…'
              : search
                ? 'No conversations found.'
                : 'Your conversations will appear here.'}
          </p>
        )}
      </div>
    </section>
  );
}

export function BuyerSidebar(props: Props) {
  return (
    <aside
      id="app-sidebar"
      className="sidebar buyer-sidebar"
      inert={props.collapsed}
      aria-hidden={props.collapsed || undefined}
    >
      <div className="ui-sidebar-brand">
        <img
          src="./assets/brand/gyblos-icon.png"
          alt=""
          width="32"
          height="32"
        />
        <strong>Gyblos</strong>
        <IconButton label="Collapse sidebar" onClick={props.onCollapse}>
          <SidebarSimple size={18} />
        </IconButton>
      </div>
      <nav aria-label="Main navigation" className="ui-sidebar-primary">
        <Button
          className="ui-nav-row"
          disabled={props.storageState === CHAT_STORAGE_STATE.LOADING}
          onClick={props.onNewChat}
        >
          <Plus size={20} />
          <span>New chat</span>
        </Button>
        {MAIN_NAV.filter(
          (item) =>
            item.name === UI_VIEW.CONNECT ||
            item.name === UI_VIEW.MODELS ||
            item.name === UI_VIEW.TOOLS,
        ).map((item) => (
          <NavigationItem
            key={item.name}
            item={item}
            view={props.view}
            navigate={props.navigate}
          />
        ))}
      </nav>
      <ConversationList {...props} />
      <nav className="ui-sidebar-footer" aria-label="Account and activity">
        {MAIN_NAV.filter(
          (item) =>
            item.name === UI_VIEW.ACTIVITY || item.name === UI_VIEW.PAYMENTS,
        ).map((item) => (
          <NavigationItem
            key={item.name}
            item={item}
            view={props.view}
            navigate={props.navigate}
          />
        ))}
        <Button
          className="ui-nav-row"
          aria-current={props.view === UI_VIEW.SETTINGS ? 'page' : undefined}
          onClick={() => props.navigate(UI_VIEW.SETTINGS)}
        >
          <GearSix size={20} />
          <span>Settings</span>
        </Button>
      </nav>
    </aside>
  );
}
