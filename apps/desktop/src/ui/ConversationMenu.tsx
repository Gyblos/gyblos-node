import {
  Copy,
  DotsThree,
  PencilSimple,
  Plus,
  PushPin,
  Trash,
} from '@phosphor-icons/react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { ChatController } from './chat-controller';
import { BUTTON_VARIANT } from './constants';
import { Dropdown } from './Dropdown';
import { FormActions, FormField, FormInput } from './Form';
import { Modal } from './Modal';
import { MotionPresence } from './Motion';
import { Button, MenuItem } from './UI';

const CONVERSATION_DIALOG = { RENAME: 'rename', DELETE: 'delete' } as const;
type ConversationDialog =
  (typeof CONVERSATION_DIALOG)[keyof typeof CONVERSATION_DIALOG];

export function ConversationMenu({
  chat,
  onNewChat,
  notify,
}: {
  chat: ChatController;
  onNewChat(): void;
  notify(message: string): void;
}) {
  const { sessions, activeId } = useSyncExternalStore(
    chat.subscribe,
    chat.getSnapshot,
  );

  const [dialog, setDialog] = useState<ConversationDialog | null>(null);
  const [name, setName] = useState('');
  useEffect(() => {
    if (dialog === CONVERSATION_DIALOG.RENAME)
      document.getElementById('preview-conversation-name')?.focus();
  }, [dialog]);
  const session = sessions.find((item) => item.id === activeId);
  if (!session?.messages.length) return null;
  const title = session.title;
  const pinned = !!session.pinned;
  const remove = () => {
    chat.deleteChat(session.id, crypto.randomUUID());
    setDialog(null);
    notify(
      'Conversation removed from the current view. Check the history save status for this device.',
    );
  };
  return (
    <>
      <Dropdown
        label="Conversation actions"
        iconOnly
        className="preview-conversation-menu"
        trigger={<DotsThree size={16} weight="bold" aria-hidden="true" />}
      >
        {(close) => (
          <>
            <MenuItem
              label="New chat"
              leading={<Plus size={16} aria-hidden="true" />}
              onClick={() => {
                close();
                onNewChat();
                document
                  .querySelector<HTMLTextAreaElement>('.composer textarea')
                  ?.focus();
              }}
            />
            <MenuItem
              label={pinned ? 'Unpin' : 'Pin'}
              leading={<PushPin size={16} aria-hidden="true" />}
              onClick={() => {
                chat.pinChat(session.id, !pinned);
                close();
              }}
            />
            <MenuItem
              label="Rename…"
              leading={<PencilSimple size={16} aria-hidden="true" />}
              onClick={() => {
                setName(title);
                setDialog(CONVERSATION_DIALOG.RENAME);
                close();
              }}
            />
            <MenuItem
              label="Copy as Markdown"
              leading={<Copy size={16} aria-hidden="true" />}
              onClick={() => {
                const text =
                  '# ' +
                  title +
                  '\n\n' +
                  session.messages
                    .map(
                      (message) =>
                        (message.role === 'user'
                          ? '**You:** '
                          : '**Gyblos:** ') + message.text,
                    )
                    .join('\n\n');
                void navigator.clipboard
                  .writeText(text)
                  .then(() => notify('Copied as Markdown'))
                  .catch(() => undefined);
                close();
              }}
            />
            <MenuItem
              disabled={!!session.run || !!session.paypalRun}
              label="Delete…"
              leading={<Trash size={16} aria-hidden="true" />}
              onClick={() => {
                setDialog(CONVERSATION_DIALOG.DELETE);
                close();
              }}
            />
          </>
        )}
      </Dropdown>
      <MotionPresence>
        {dialog === CONVERSATION_DIALOG.RENAME && (
          <Modal
            title="Rename conversation"
            size="sm"
            close={() => setDialog(null)}
          >
            <form
              className="ui-form"
              onSubmit={(event) => {
                event.preventDefault();
                const next = name.trim();
                if (next) chat.renameChat(session.id, next);
                setDialog(null);
                if (next) notify('Conversation renamed');
              }}
            >
              <FormField label="Name" htmlFor="preview-conversation-name">
                <FormInput
                  id="preview-conversation-name"
                  value={name}
                  maxLength={80}
                  autoFocus
                  onChange={(event) => setName(event.target.value)}
                />
              </FormField>
              <FormActions>
                <Button type="button" onClick={() => setDialog(null)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant={BUTTON_VARIANT.PRIMARY}
                  disabled={!name.trim()}
                >
                  Save
                </Button>
              </FormActions>
            </form>
          </Modal>
        )}
        {dialog === CONVERSATION_DIALOG.DELETE && (
          <Modal
            title="Delete conversation?"
            description={
              '"' +
              title +
              '" will be removed from your conversation history when it is saved.'
            }
            size="sm"
            close={() => setDialog(null)}
          >
            <FormActions>
              <Button onClick={() => setDialog(null)}>Cancel</Button>
              <Button
                className="preview-destructive"
                disabled={!!session.run || !!session.paypalRun}
                onClick={remove}
              >
                Delete
              </Button>
            </FormActions>
          </Modal>
        )}
      </MotionPresence>
    </>
  );
}
