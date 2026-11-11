// A short conversation with every role, as agents send one: a system message, a turn each, then the user.
import type { ChatMessage } from '@gyblos/protocol/chat';

export const CONVERSATION: ChatMessage[] = [
  { role: 'system', content: 'Answer briefly.' },
  { role: 'user', content: 'My name is Ana.' },
  { role: 'assistant', content: 'Nice to meet you, Ana.' },
  { role: 'user', content: 'What is my name?' },
];
