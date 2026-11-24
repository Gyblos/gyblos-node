import {
  ChatCircle,
  Check,
  FunnelSimple,
  MagnifyingGlass,
  X,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { ChatController } from './chat-controller';
import type { ChatSession } from './chat-state';
import { USAGE_CALENDAR } from './constants';
import { Dropdown } from './Dropdown';
import { Button, IconButton, MenuItem, SearchField } from './UI';

const FILTER = {
  ALL: 'All chats',
  UNREAD: 'Unread',
  PINNED: 'Pinned',
} as const;
const GROUPS = [
  'Pinned',
  'Today',
  'Yesterday',
  'Previous 7 days',
  'Older',
] as const;
function group(session: ChatSession, today: Date) {
  if (session.pinned) return GROUPS[0];
  const at = session.messages
    .slice()
    .reverse()
    .find((message) => message.sentAt != null)?.sentAt;
  if (at == null) return GROUPS[4];
  const date = new Date(at);
  const days =
    (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
      Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) /
    USAGE_CALENDAR.dayMs;
  return days <= 0
    ? GROUPS[1]
    : days === 1
      ? GROUPS[2]
      : days <= USAGE_CALENDAR.weekDays
        ? GROUPS[3]
        : GROUPS[4];
}
function useUnread(
  sessions: ChatSession[],
  activeId: string,
  chatVisible: boolean,
) {
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => new Set());
  const running = useRef(new Set<string>());
  useEffect(() => {
    const next = new Set(
      sessions
        .filter((session) => session.run || session.paypalRun)
        .map((session) => session.id),
    );
    const finished = [...running.current].filter(
      (id) => !next.has(id) && (!chatVisible || id !== activeId),
    );
    running.current = next;
    setUnread((old) => {
      if (!finished.length && !(chatVisible && old.has(activeId))) return old;
      const updated = new Set([...old, ...finished]);
      if (chatVisible) updated.delete(activeId);
      return updated;
    });
  }, [sessions, activeId, chatVisible]);
  return unread;
}
export function ConversationHistory({
  chat,
  chatVisible,
  loading,
  open,
}: {
  chat: ChatController;
  chatVisible: boolean;
  loading: boolean;
  open(id: string): void;
}) {
  const { sessions, activeId } = useSyncExternalStore(
    chat.subscribe,
    chat.getSnapshot,
  );
  const [searching, setSearching] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTER)[keyof typeof FILTER]>(
    FILTER.ALL,
  );
  const [query, setQuery] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const unread = useUnread(sessions, activeId, chatVisible);
  const closeSearch = () => {
    setSearching(false);
    setQuery('');
    trigger.current?.focus();
  };
  const groups = groupHistory(sessions, query, filter, unread);
  return (
    <>
      <HistoryHeader
        {...{
          trigger,
          searching,
          closeSearch,
          setSearching,
          filter,
          setFilter,
        }}
      />
      {searching && (
        <SearchField
          autoFocus
          label="Search conversations"
          placeholder="Search conversations"
          value={query}
          onValueChange={setQuery}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
            event.stopPropagation();
            closeSearch();
          }}
        />
      )}
      <HistoryGroups
        {...{
          groups,
          loading,
          query,
          filter,
          unread,
          activeId,
          chatVisible,
          open,
        }}
      />
    </>
  );
}

function HistoryGroups({
  groups,
  loading,
  query,
  filter,
  unread,
  activeId,
  chatVisible,
  open,
}: {
  groups: Map<string, ChatSession[]>;
  loading: boolean;
  query: string;
  filter: string;
  unread: ReadonlySet<string>;
  activeId: string;
  chatVisible: boolean;
  open(id: string): void;
}) {
  return (
    <div className="preview-chat-groups">
      {GROUPS.map(
        (key) =>
          groups.has(key) && (
            <section key={key} aria-label={key}>
              <h3 className="preview-chat-group-title">{key}</h3>
              {groups.get(key)?.map((session) => (
                <Button
                  key={session.id}
                  className="ui-nav-row preview-chat-row"
                  disabled={loading}
                  aria-current={
                    chatVisible && session.id === activeId ? 'page' : undefined
                  }
                  onClick={() => open(session.id)}
                >
                  <span>
                    {session.messages.length
                      ? session.title
                      : session.draft.trim()}
                  </span>
                  {(session.run ||
                    session.paypalRun ||
                    unread.has(session.id)) && (
                    <span
                      className="preview-chat-state"
                      data-state={
                        session.run || session.paypalRun ? 'running' : 'unread'
                      }
                      role="img"
                      aria-label={
                        session.run || session.paypalRun
                          ? 'Answering'
                          : 'New answer'
                      }
                    />
                  )}
                </Button>
              ))}
            </section>
          ),
      )}
      {!groups.size && (
        <p className="pk-empty-line" role="status">
          <ChatCircle size={16} />
          {loading
            ? 'Loading conversations…'
            : query || filter !== FILTER.ALL
              ? 'No conversations found.'
              : 'Your conversations will appear here.'}
        </p>
      )}
    </div>
  );
}

function HistoryHeader({
  trigger,
  searching,
  closeSearch,
  setSearching,
  filter,
  setFilter,
}: {
  trigger: React.RefObject<HTMLButtonElement | null>;
  searching: boolean;
  closeSearch(): void;
  setSearching(value: boolean): void;
  filter: (typeof FILTER)[keyof typeof FILTER];
  setFilter(value: (typeof FILTER)[keyof typeof FILTER]): void;
}) {
  return (
    <header className="preview-chat-panel-head">
      <h2 className="ui-sidebar-section-title">Chats</h2>
      <IconButton
        ref={trigger}
        label={searching ? 'Close search' : 'Search conversations'}
        aria-expanded={searching}
        onClick={() => (searching ? closeSearch() : setSearching(true))}
      >
        {searching ? <X size={14} /> : <MagnifyingGlass size={14} />}
      </IconButton>
      <Dropdown
        label={'Filter conversations: ' + filter}
        iconOnly
        trigger={<FunnelSimple size={14} />}
        className="preview-chat-filter"
      >
        {(close) =>
          Object.values(FILTER).map((value) => (
            <MenuItem
              key={value}
              role="menuitemradio"
              checked={filter === value}
              label={value}
              trailing={filter === value && <Check size={14} />}
              onClick={() => {
                setFilter(value);
                close();
              }}
            />
          ))
        }
      </Dropdown>
    </header>
  );
}

function groupHistory(
  sessions: readonly ChatSession[],
  query: string,
  filter: string,
  unread: ReadonlySet<string>,
) {
  const groups = new Map<string, ChatSession[]>();
  const today = new Date();
  for (const session of sessions.slice().reverse()) {
    const title = session.messages.length
      ? session.title
      : session.draft.trim();
    if (
      !title ||
      !title.toLowerCase().includes(query.trim().toLowerCase()) ||
      (filter === FILTER.UNREAD && !unread.has(session.id)) ||
      (filter === FILTER.PINNED && !session.pinned)
    )
      continue;
    const key = group(session, today);
    const list = groups.get(key) ?? [];
    list.push(session);
    groups.set(key, list);
  }
  return groups;
}
