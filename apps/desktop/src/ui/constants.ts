// Owns simulated UI catalogs and precomputed brand morph paths; never live network state.
import { MODEL_IDS } from '@gyblos/protocol/constants';

import { AGENT_CLIENT } from '../constants';
import { LOCAL_NODE_STATE } from '../node-status';
import type { CatalogModel } from './model-types';

export const TOP_UP_STATUS = {
  INVALID_AMOUNT: 'invalid-amount',
  WALLET_UNAVAILABLE: 'wallet-unavailable',
  BACKUP_REQUIRED: 'backup-required',
  PAYMENT_UNAVAILABLE: 'payment-unavailable',
} as const;
export const TOP_UP_AMOUNTS = ['10', '25', '50'] as const;

export const COPY_RESULT = {
  COPIED: 'copied',
  UNAVAILABLE: 'unavailable',
} as const;

export const CHAT_PHASE = {
  CONNECTING: 'connecting',
  TOOLS: 'tools',
  RESPONDING: 'responding',
} as const;
export const MESSAGE_STATE = {
  PENDING: 'pending',
  COMPLETE: 'complete',
  STOPPED: 'stopped',
  FAILED: 'failed',
} as const;

export const SIGNAL_STATE = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  WORKING: 'working',
  RESPONDING: 'responding',
  COMPLETE: 'complete',
  STOPPED: 'stopped',
  PAUSED: 'paused',
} as const;
export type SignalState = (typeof SIGNAL_STATE)[keyof typeof SIGNAL_STATE];

export const SLIDE_DIRECTION = {
  FORWARD: 'forward',
  BACKWARD: 'backward',
} as const;
export const SLIDE_SURFACE = {
  WORKSPACE: 'workspace',
  AGENT_OUTPUT: 'agent-output',
} as const;

export const CONNECTION_TOOLS = [
  AGENT_CLIENT.CLAUDE_CODE,
  AGENT_CLIENT.CODEX,
  AGENT_CLIENT.PI,
  AGENT_CLIENT.OTHER,
] as const;
export const CONNECTION_PRESET = { GENERIC: 'Other app / API' } as const;
export const PAYPAL_AGENT_CARDS = [
  { client: CONNECTION_PRESET.GENERIC },
  { client: AGENT_CLIENT.OPENCODE },
  { client: AGENT_CLIENT.CODEX },
  { client: AGENT_CLIENT.PI },
  { client: AGENT_CLIENT.CLAUDE_CODE },
] as const;
export type ConnectionPreset = (typeof PAYPAL_AGENT_CARDS)[number]['client'];

export const CHAT_ROLE = { USER: 'user', ASSISTANT: 'assistant' } as const;
export const BUTTON_VARIANT = {
  GHOST: 'ghost',
  SECONDARY: 'secondary',
  TONAL: 'tonal',
  PRIMARY: 'primary',
} as const;

export const TOOLS = [
  {
    id: 'exa',
    name: 'Exa',
    capability: 'Search',
    description: 'Find relevant pages on the web.',
    docs: 'https://exa.ai/docs/reference/search',
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    capability: 'Read pages',
    description: 'Extract readable content from a page.',
    docs: 'https://docs.firecrawl.dev/introduction',
  },
  {
    id: 'tinyfish',
    name: 'TinyFish',
    capability: 'Browse',
    description: 'Work through a multi-step browser task.',
    docs: 'https://www.tinyfish.ai/',
  },
] as const;

export const MOTION_VARIANT = {
  SURFACE: 'surface',
  SLIDE: 'slide',
  EXPAND: 'expand',
} as const;

export const CHAT_PREVIEW = {
  STREAM_DELAY_MS: 65,
  TOOL_DELAY_MS: 1100,
  CONNECT_DELAY_MS: 900,
  MODEL_PULSE_MS: 1100,
  COPY_NOTICE_MS: 1600,
  INPUT_MAX_HEIGHT: 160,
  INPUT_MIN_HEIGHT: 48,
  FOLLOW_THRESHOLD: 72,
  TITLE_LENGTH: 52,
  STREAM_CHUNK: 28,
} as const;
export const MENU_GEOMETRY = {
  WIDTH: 280,
  MIN_TOP: 80,
  QUICK_MODELS: 3,
} as const;
export const MOTION_CLEANUP_MS = 450;
export const CONNECTION_BUDGET = { MAX_DAILY: 10000, CENTS: 100 } as const;

export const UI_VIEW = {
  CHAT: 'Chat',
  CONNECT: 'Connect',
  TOOLS: 'Tools',
  MODELS: 'Models',
  ACTIVITY: 'Activity',
  PAYMENTS: 'Payments',
  SETTINGS: 'Settings',
} as const;
export const UI_DIALOG = {
  BACKUP: 'backup',
  DESIGN_SYSTEM: 'design-system',
  BUDGET: 'budget',
  ADD_FUNDS: 'add-funds',
} as const;
export const MODEL_SOURCE = {
  ANNOUNCED: 'announced',
  PREVIEW: 'preview',
} as const;
export const MODEL_CATEGORY = {
  EVERYDAY: 'Everyday',
  REASONING: 'Reasoning',
  WRITING: 'Writing',
  CODING: 'Coding',
} as const;
export const MODEL_FILTER = {
  ALL: 'All models',
  FREE: 'Free',
  REASONING: MODEL_CATEGORY.REASONING,
  CODING: MODEL_CATEGORY.CODING,
} as const;

export const MODELS: [CatalogModel, CatalogModel, ...CatalogModel[]] = [
  {
    id: 'qwen',
    catalogId: MODEL_IDS.QWEN3_30B_A3B,
    name: 'Qwen3 30B-A3B',
    family: 'Qwen',
    image: { src: './assets/models/qwen-color.svg' },
    category: MODEL_CATEGORY.EVERYDAY,
    context: '32K',
    providers: 12,
    free: true,
    input: 0,
    output: 0,
  },
  {
    id: 'oss',
    catalogId: MODEL_IDS.GPT_OSS_20B,
    name: 'gpt-oss 20B',
    family: 'OpenAI',
    image: { src: './assets/models/openai.svg', monochrome: true },
    category: MODEL_CATEGORY.REASONING,
    context: '128K',
    providers: 8,
    free: true,
    input: 0,
    output: 0,
  },
  {
    id: 'llama',
    catalogId: MODEL_IDS.LLAMA_3_3_70B,
    name: 'Llama 3.3 70B',
    family: 'Meta',
    image: { src: './assets/models/meta-color.svg' },
    category: MODEL_CATEGORY.WRITING,
    context: '128K',
    providers: 7,
    free: false,
    input: 0.12,
    output: 0.35,
  },
  {
    id: 'gemma',
    catalogId: MODEL_IDS.GEMMA_4_26B,
    name: 'Gemma 4 26B',
    family: 'Google',
    image: { src: './assets/models/gemma-color.svg' },
    category: MODEL_CATEGORY.EVERYDAY,
    context: '128K',
    providers: 5,
    free: false,
    input: 0.08,
    output: 0.24,
  },
  {
    id: 'deepseek',
    catalogId: MODEL_IDS.DEEPSEEK_V4_1_FLASH,
    name: 'DeepSeek V4.1 Flash',
    family: 'DeepSeek',
    image: { src: './assets/models/deepseek-color.svg' },
    category: MODEL_CATEGORY.CODING,
    context: '128K',
    providers: 16,
    free: false,
    input: 0.14,
    output: 0.28,
  },
];

export const ADDITIONAL_MODEL_ARTWORK = [
  { prefix: 'claude', image: { src: './assets/models/claude-color.svg' } },
  { prefix: 'gemini', image: { src: './assets/models/gemini-color.svg' } },
  { prefix: 'mistral', image: { src: './assets/models/mistral-color.svg' } },
] as const;

export const MAIN_NAV = [
  { name: UI_VIEW.CHAT, label: 'Chat' },
  { name: UI_VIEW.CONNECT, label: 'Connections' },
  { name: UI_VIEW.MODELS, label: 'Models' },
  { name: UI_VIEW.TOOLS, label: 'Applications' },
  { name: UI_VIEW.ACTIVITY, label: 'Activity' },
  { name: UI_VIEW.PAYMENTS, label: 'Payments' },
] as const;
export const ROUTE_ORDER = [
  UI_VIEW.CHAT,
  UI_VIEW.MODELS,
  UI_VIEW.TOOLS,
  UI_VIEW.CONNECT,
  UI_VIEW.ACTIVITY,
  UI_VIEW.PAYMENTS,
  UI_VIEW.SETTINGS,
] as const;
export const SIDEBAR_MOTION_MS = 300;

export const NETWORK_STATE = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  PAUSED: 'paused',
} as const;

export const LOCAL_NODE_LABELS = {
  [LOCAL_NODE_STATE.STARTING]: 'Starting node',
  [LOCAL_NODE_STATE.READY]: 'Node ready',
  [LOCAL_NODE_STATE.STOPPING]: 'Stopping node',
  [LOCAL_NODE_STATE.STOPPED]: 'Node stopped',
  [LOCAL_NODE_STATE.ERROR]: 'Node unavailable',
} as const;

export const DEMO_AUTH = {
  APPROVED: 'approved',
  OFFLINE: 'offline',
  BALANCE: 'balance',
  LIMIT: 'limit',
} as const;
export const DEMO_ACCOUNT = {
  REQUEST_COST: 0.001,
  UNITS_PER_CREDIT: 1000,
  TOP_UP: 10,
  DEFAULT_BUDGET: 2,
  TOAST_MS: 3000,
  SAMPLE_REQUESTS: 4,
} as const;
export const NAVIGATION_WIDTH = { MIN: 224, DEFAULT: 224, MAX: 360 } as const;
export const HISTORY_KEY = {
  BACK: 'ArrowLeft',
  FORWARD: 'ArrowRight',
} as const;
export const WORKSPACE_BREAKPOINT = { SIDEBAR: 900, CONTEXT: 1200 } as const;

export const SIDEBAR_ACTION = {
  CREATE: 'create',
  CLEAR: 'clear',
  PANEL: 'panel',
  STATUS: 'status',
  SETTINGS: 'settings',
  WALLET: 'wallet',
  TOOLS: 'tools',
  LINK: 'link',
  CHAT: 'chat',
  SEARCH: 'search',
} as const;

export const SIDEBAR_TYPING_POSITIONS = [88, 128, 168] as const;
