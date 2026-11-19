// Browser-only example data for the unchanged desktop renderer. No network, keys or filesystem APIs.
import { DEVNET, DEVNET_USDC } from '@gyblos/config/network';
import { modelArtwork } from '@gyblos/desktop/announced-models';
import {
  projectChatArchive,
  type ChatArchiveSave,
} from '@gyblos/desktop/chat-archive-model';
import { ChatController } from '@gyblos/desktop/chat-controller';
import { CATALOG_STATE } from '@gyblos/desktop/network-catalog';
import { LOCAL_NODE_STATE } from '@gyblos/desktop/node-status';
import { PAYMENT_METHOD } from '@gyblos/desktop/paypal-model';
import {
  RESPONSE_COST_KIND,
  RESPONSE_COST_UNIT,
} from '@gyblos/desktop/response-metrics';
import {
  emptyUsdcApi,
  parseUsdcApiState,
  USDC_API_ACTION,
  type UsdcApiState,
} from '@gyblos/desktop/usdc-api-model';
import {
  BACKUP_RESULT,
  parseWalletSummary,
  WALLET_STATUS,
} from '@gyblos/desktop/wallet';
import { WALLET_SETTINGS_RESULT } from '@gyblos/desktop/wallet-settings-model';
import { windowPlatform } from '@gyblos/desktop/window-chrome';
import {
  emptyX402,
  parseX402Result,
  X402_ACTION,
  type X402Record,
} from '@gyblos/desktop/x402-model';
import { AGENT_TOOLS } from '@gyblos/node/agent-setup-constants';
import { BUYER_API, type BuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import { BUYER_API_KEYS } from '@gyblos/protocol/buyer-api-keys';

import { accountBudgetSnapshot, accountLimitError } from './account-budget';
import { PREVIEW } from './constants';
import { exampleKeys } from './example-keys';
import { requestObject as read, type AgentExamples } from './input';
import { createPaypalPreview } from './paypal';

export function createPreviewHost(
  search: string,
  agentExamples: AgentExamples,
) {
  const query = new URLSearchParams(search);
  const ready = query.get('connection-state') !== 'unconfigured';
  const example = '00000000-0000-4000-8000-000000000001';
  const now = Date.now();
  const model = 'qwen3-0.6b';
  const chatModel = {
    id: model,
    name: model,
    image: modelArtwork(model),
    free: true,
  };
  const payer = '11111111111111111111111111111111';
  const scope = { network: DEVNET, mint: DEVNET_USDC, payer };
  const policy: BuyerApiPolicy = {
    version: BUYER_API.VERSION,
    policyId: example,
    model,
    maxTokens: 256,
    maxAtomic: '0',
    ...scope,
  };
  const sessionId = '00000000-0000-4000-8000-000000000003';
  let connected = ready;
  let active = ready;
  let authorized = ready;
  let limitAtomic = '1000000';
  let generation = 0;
  let selectedHome = ready;
  let keys = exampleKeys(query.get('keys') === 'empty');
  let setup: UsdcApiState['setup'];
  const clone = <T>(value: T) => structuredClone(value);
  const answer =
    'This is the desktop interface with example data.\n\nYour **API key** and **Base URL** are in Connections. The key’s spend limit is shared across its tools and models.\n\n- Open your preferred coding tool.\n- Follow its configuration guide.\n- Review usage in Activity and payment details in Payments.';

  const conversations = new ChatController('preview-first-chat');
  const records: X402Record[] = [];
  function recordFreeReply(id: string, at: number) {
    records.push({
      id,
      sessionId,
      at,
      chargeAtomic: '0',
      transaction: null,
      free: true,
      policy,
    });
  }
  const tenChats = query.get('review') === 'ten-chats';
  const titles = [
    'Product launch plan',
    'Explain vector search',
    'Research assistant',
  ];
  if (tenChats)
    titles.push(
      'Review API changes',
      'Plan the onboarding flow',
      'Compare model outputs',
      'Summarize meeting notes',
      'Explore search ranking',
      'Outline a release checklist',
    );
  function exampleChat(title: string, receiptId: string) {
    const conversationId = conversations.getSnapshot().activeId;
    conversations.startPaypal(
      title,
      chatModel,
      receiptId,
      sessionId,
      PAYMENT_METHOD.USDC,
    );
    conversations.completePaypal(conversationId, receiptId, answer, chatModel, {
      inputTokens: 86,
      outputTokens: 144,
      firstTokenMs: null,
      generationMs: null,
      responseMs: 1840,
      cost: {
        amount: '0',
        unit: RESPONSE_COST_UNIT.USDC,
        kind: RESPONSE_COST_KIND.SETTLED,
      },
    });
    recordFreeReply(
      receiptId,
      tenChats
        ? now -
            (titles.length - records.length) * PREVIEW.dayMs -
            PREVIEW.minuteMs
        : now - PREVIEW.minuteMs,
    );
  }
  for (const title of titles) {
    if (tenChats) exampleChat(title, crypto.randomUUID());
    else conversations.setDraft(title);
    conversations.newChat(crypto.randomUUID());
  }
  exampleChat('How can I use Gyblos in my coding tools?', 'preview-free-reply');
  let archive = projectChatArchive(conversations.getSnapshot());

  const desktopWindow = { platform: windowPlatform(PREVIEW.platform) };
  const desktopConversations = {
    load: async () => ({
      available: true,
      generation: 1,
      savedSequence: generation,
      archive: clone(archive),
    }),
    status: async () => ({
      available: true,
      generation: 1,
      savedSequence: generation,
    }),
    save: async (request: ChatArchiveSave) => {
      archive = clone(request.archive);
      generation = request.sequence;
      return { available: true, generation: 1, savedSequence: generation };
    },
  };
  const wallet = parseWalletSummary({
    status: WALLET_STATUS.READY,
    address: payer,
    backupVerified: query.get('backup') !== 'needed',
    fundingEnabled: false,
  });
  const desktopWallet = {
    summary: async () => clone(wallet),
    collection: async () => ({
      wallet: clone(wallet),
      wallets: [clone(wallet)],
    }),
    copyAddress: async () => {
      await navigator.clipboard.writeText(payer);
      return true;
    },
    manage: async () => WALLET_SETTINGS_RESULT.CANCELLED,
    backup: async () => BACKUP_RESULT.CANCELLED,
  };
  const requestedNode = query.get('node-state');
  let nodeState =
    Object.values(LOCAL_NODE_STATE).find((value) => value === requestedNode) ??
    LOCAL_NODE_STATE.READY;
  let readyAt: number | null = null;
  const desktopNode = {
    summary: async () => {
      if (readyAt !== null && Date.now() >= readyAt) {
        nodeState = LOCAL_NODE_STATE.READY;
        readyAt = null;
      }
      return nodeState;
    },
    retry: async () => {
      if (
        nodeState === LOCAL_NODE_STATE.ERROR ||
        nodeState === LOCAL_NODE_STATE.STOPPED
      ) {
        nodeState = LOCAL_NODE_STATE.STARTING;
        readyAt = Date.now() + PREVIEW.nodeStartupMs;
      }
      return nodeState;
    },
  };
  const catalog = (search = '') => ({
    state: CATALOG_STATE.READY,
    query: search,
    checkedAt: now,
    truncated: false,
    models: [
      {
        modelId: model,
        variant: null,
        quantization: 'Q4_K_M',
        contextTokens: 2048,
        announcements: 1,
        expiresAt: now + PREVIEW.dayMs,
      },
    ],
  });
  let catalogQuery = '';
  const catalogResult = () => {
    const result = catalog(catalogQuery);
    return !catalogQuery || catalogQuery === model
      ? result
      : { ...result, state: CATALOG_STATE.EMPTY, models: [] };
  };
  const desktopCatalog = {
    summary: async () => catalogResult(),
    lookup: async (value: unknown) => {
      catalogQuery = typeof value === 'string' ? value.trim() : '';
      return catalogResult();
    },
  };

  const accountBudget = () => accountBudgetSnapshot(limitAtomic, keys, records);
  function buyerState() {
    return parseX402Result({
      summary: {
        ...emptyX402(),
        active,
        policy: connected ? policy : null,
        sessionId: authorized ? sessionId : null,
        limitAtomic,
        records: authorized ? records : [],
      },
      policy: connected ? policy : null,
      homeSelected: selectedHome,
    });
  }
  const desktopX402 = {
    onProgress: () => () => {},
    run: async (input: unknown) => {
      const request = read(input);
      if (
        request.action === X402_ACTION.START_BUYER ||
        request.action === X402_ACTION.CONNECT
      ) {
        connected = true;
        selectedHome = true;
      }
      if (request.action === X402_ACTION.AUTHORIZE) {
        if (!connected || typeof request.limitAtomic !== 'string')
          return { ...buyerState(), error: 'Account budget unavailable.' };
        const error = accountLimitError(
          request.limitAtomic,
          accountBudget().spentAtomic,
        );
        if (error) return { ...buyerState(), error };
        limitAtomic = request.limitAtomic;
        active = true;
        authorized = true;
      }
      if (request.action === X402_ACTION.FINISH) active = false;
      if (request.action === X402_ACTION.COPY_PAYER)
        await navigator.clipboard.writeText(payer);
      if (request.action === X402_ACTION.COPY_MINT)
        await navigator.clipboard.writeText(DEVNET_USDC);
      if (request.action === X402_ACTION.SEND) {
        await new Promise((resolve) =>
          window.setTimeout(resolve, PREVIEW.replyDelayMs),
        );
        if (
          typeof request.id === 'string' &&
          !records.some((record) => record.id === request.id)
        )
          recordFreeReply(request.id, Date.now());
        return {
          ...buyerState(),
          reply: {
            text: answer,
            model,
            metrics: {
              inputTokens: 86,
              outputTokens: 144,
              firstTokenMs: null,
              generationMs: null,
              responseMs: 1840,
              cost: {
                amount: '0',
                unit: RESPONSE_COST_UNIT.USDC,
                kind: RESPONSE_COST_KIND.SETTLED,
              },
            },
          },
        };
      }
      return buyerState();
    },
  };
  function apiState() {
    if (!connected) return emptyUsdcApi();
    return parseUsdcApiState({
      snapshot: {
        version: BUYER_API_KEYS.VERSION,
        scope,
        keys,
        blocked: false,
      },
      policyId: example,
      url: 'http://127.0.0.1:8000/v1',
      model,
      copyable: keys.filter((key) => !key.revoked).map((key) => key.id),
      error: null,
      ...(setup ? { setup } : {}),
    });
  }
  const desktopUsdcApiKeys = {
    run: async (input: unknown) => {
      const request = read(input);
      if (
        request.action === USDC_API_ACTION.CREATE &&
        typeof request.name === 'string' &&
        typeof request.limitAtomic === 'string'
      )
        keys = [
          ...keys,
          {
            id: crypto.randomUUID(),
            name: request.name,
            limitAtomic: request.limitAtomic,
            spentAtomic: '0',
            settledAtomic: '0',
            approvedAtomic: '0',
            reservedAtomic: '0',
            revoked: false,
          },
        ];
      if (request.action === USDC_API_ACTION.REVOKE)
        keys = keys.map((key) =>
          key.id === request.id ? { ...key, revoked: true } : key,
        );
      if (request.action === USDC_API_ACTION.COPY_KEY)
        await navigator.clipboard.writeText('PREVIEW_ONLY_NOT_A_VALID_API_KEY');
      if (request.action === USDC_API_ACTION.COPY_URL)
        await navigator.clipboard.writeText('http://127.0.0.1:8000/v1');
      if (
        [
          USDC_API_ACTION.PREVIEW_AGENT,
          USDC_API_ACTION.COPY_AGENT,
          USDC_API_ACTION.WRITE_AGENT,
        ].some((value) => value === request.action)
      ) {
        const tool =
          Object.values(AGENT_TOOLS).find((tool) => tool === request.tool) ??
          AGENT_TOOLS.OPENCODE;
        setup = { tool, text: agentExamples.usdc[tool], models: [model] };
        if (request.action === USDC_API_ACTION.COPY_AGENT)
          await navigator.clipboard.writeText(setup.text);
        if (request.action === USDC_API_ACTION.WRITE_AGENT)
          return {
            ...apiState(),
            error: 'Preview only. Configuration files are not written.',
          };
      }
      return apiState();
    },
  };

  return {
    desktopWindow,
    desktopConversations,
    desktopWallet,
    desktopNode,
    desktopCatalog,
    desktopX402,
    previewAccountBudget: { current: accountBudget, baseline: accountBudget() },
    desktopUsdcApiKeys,
    ...createPaypalPreview(ready, answer, now, agentExamples.paypal),
  };
}
