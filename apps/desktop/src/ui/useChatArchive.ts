// React lifetime for private conversation autosave; persistence never authorizes inference or payments.
import { useEffect, useState } from 'react';

import type { ChatArchivePort } from '../chat-archive-model';
import { CHAT_STORAGE_STATE, type ChatArchiveState } from '../constants';
import { ChatArchiveClient } from './chat-archive-client';
import type { ChatController } from './chat-controller';

declare global {
  interface Window {
    desktopConversations?: ChatArchivePort;
  }
}
export function useChatArchive(chat: ChatController) {
  const [state, setState] = useState<ChatArchiveState>(
    CHAT_STORAGE_STATE.LOADING,
  );
  useEffect(() => {
    const client = new ChatArchiveClient(
      chat,
      window.desktopConversations,
      setState,
    );
    void client.start();
    return client.close;
  }, [chat]);
  return state;
}
export function chatArchiveLabel(state: ChatArchiveState) {
  switch (state) {
    case CHAT_STORAGE_STATE.LOADING:
      return 'Loading conversations…';
    case CHAT_STORAGE_STATE.SAVING:
      return 'Saving on this device…';
    case CHAT_STORAGE_STATE.SAVED:
      return 'Conversations and drafts are saved on this device.';
    case CHAT_STORAGE_STATE.UNAVAILABLE:
      return 'Conversation saving is unavailable. New messages and drafts may be lost when Gyblos closes.';
  }
}
