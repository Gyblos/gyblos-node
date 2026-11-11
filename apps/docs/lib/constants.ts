// Canonical docs icon identities and assistant handoff endpoints. Links prefill; they do not submit.
export const ASSISTANT_IDS = {
  CHATGPT: 'chatgpt',
  CLAUDE: 'claude',
  CLAUDE_CODE: 'claude-code',
  CURSOR: 'cursor',
} as const;
export type AssistantId = (typeof ASSISTANT_IDS)[keyof typeof ASSISTANT_IDS];

export const ASSISTANTS = [
  {
    id: ASSISTANT_IDS.CHATGPT,
    name: 'ChatGPT',
    endpoint: 'https://chatgpt.com/',
    parameter: 'prompt',
  },
  {
    id: ASSISTANT_IDS.CLAUDE,
    name: 'Claude',
    endpoint: 'https://claude.ai/new',
    parameter: 'q',
  },
  // Official Desktop format: https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link
  {
    id: ASSISTANT_IDS.CLAUDE_CODE,
    name: 'Claude Code',
    endpoint: 'claude://code/new',
    parameter: 'q',
  },
  {
    id: ASSISTANT_IDS.CURSOR,
    name: 'Cursor',
    endpoint: 'https://cursor.com/link/prompt',
    parameter: 'text',
  },
] as const;

export const SIDEBAR_ICON_IDS = {
  COMPASS: 'compass',
  SERVER: 'server',
  PLUG: 'plug',
  BOOK_OPEN: 'book-open',
  LIFE_BUOY: 'life-buoy',
} as const;
export type SidebarIconId =
  (typeof SIDEBAR_ICON_IDS)[keyof typeof SIDEBAR_ICON_IDS];
