// Synthetic conversation fixtures shared by persistence and autosave lifecycle tests.
import { ChatController } from '@gyblos/desktop/chat-controller';

export const model = {
  id: 'qwen3:0.6b',
  name: 'Synthetic model',
  image: { src: './assets/brand/gyblos-icon.png' },
  free: false,
};
export function conversation() {
  const chat = new ChatController('first', () => 123);
  chat.startPaypal('Synthetic question', model, 'paid', 'a'.repeat(64));
  chat.completePaypal('first', 'paid', 'Synthetic answer', model);
  chat.setDraft('Unsent draft');
  return chat;
}
export function files() {
  let text: string | undefined;
  return {
    read: async () => text,
    write: async (value: string) => {
      text = value;
    },
  };
}
