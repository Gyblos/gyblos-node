// Main-frame owner actions; delegated secrets remain in host memory and copy without being revealed.
import {
  AGENT_SETUP_CODES,
  AGENT_TOOLS,
  AgentSetupError,
} from '@gyblos/node/agent-setup';
import { BUYER_API, type BuyerApiPolicy } from '@gyblos/protocol/buyer-api';
import { parseBuyerApiKeyCommand } from '@gyblos/protocol/buyer-api-keys';

import { prepareAgentSetup, type AgentSetupFiles } from './agent-setup-host';
import { paypalAgentExample } from './paypal-agent-example';
import {
  emptyUsdcApi,
  USDC_API_ACTION,
  type UsdcApiState,
} from './usdc-api-model';
import type { X402Client } from './x402-client';

type Owner = { contents: unknown; mainFrame(): unknown; destroyed(): boolean };
type Client = Pick<X402Client, 'manageApiKeys' | 'policy'> &
  Partial<Pick<X402Client, 'agentEndpoint'>>;
type Sender = { sender: unknown; senderFrame: unknown };
class UsdcApiHost {
  private readonly secrets = new Map<string, string>();
  private state = emptyUsdcApi();
  private busy = false;
  private closed = false;
  private binding: BuyerApiPolicy | null = null;
  constructor(
    private readonly client: Client,
    private readonly owner: Owner,
    private readonly copy: (value: string) => void,
    private readonly files?: AgentSetupFiles,
  ) {}
  close() {
    this.closed = true;
    this.secrets.clear();
  }
  private current() {
    const policy = this.client.policy();
    if (
      !policy ||
      !this.binding ||
      policy.network !== this.binding.network ||
      policy.mint !== this.binding.mint ||
      policy.payer !== this.binding.payer
    ) {
      this.secrets.clear();
      this.state = emptyUsdcApi();
      this.binding = policy;
    }
    return policy;
  }
  private async refresh(command?: Parameters<X402Client['manageApiKeys']>[0]) {
    const result = await this.client.manageApiKeys(command);
    this.binding = this.client.policy();
    if (
      this.closed ||
      !this.binding ||
      this.binding.network !== result.snapshot.scope.network ||
      this.binding.mint !== result.snapshot.scope.mint ||
      this.binding.payer !== result.snapshot.scope.payer
    )
      throw new Error('Buyer changed');
    if (result.created)
      this.secrets.set(result.created.id, result.created.secret);
    for (const key of result.snapshot.keys)
      if (key.revoked) this.secrets.delete(key.id);
    this.state = {
      snapshot: result.snapshot,
      policyId: this.binding.policyId,
      url: result.url,
      model: result.model,
      copyable: result.snapshot.keys
        .filter((key) => !key.revoked && this.secrets.has(key.id))
        .map((key) => key.id),
      error: null,
      ...(this.state.policyId === this.binding.policyId && this.state.setup
        ? { setup: this.state.setup }
        : {}),
    };
    return structuredClone(this.state);
  }
  private async copyConnection(input: Record<string, unknown>) {
    if (
      Object.keys(input).sort().join(',') !== 'action,id,policyId' ||
      typeof input.id !== 'string' ||
      !BUYER_API.POLICY_PATTERN.test(input.id)
    )
      throw new Error('Invalid key action');
    await this.refresh();
    const key = this.state.snapshot?.keys.find(
      (key) => key.id === input.id && !key.revoked,
    );
    if (!key || !this.state.url || !this.state.model)
      throw new Error('API key is unavailable');
    if (input.action === USDC_API_ACTION.COPY_URL) this.copy(this.state.url);
    else if (input.action === USDC_API_ACTION.COPY_KEY) {
      const secret = this.secrets.get(key.id);
      if (!secret)
        throw new Error(
          'Secret is only available in the app session that created it',
        );
      this.copy(secret);
    } else if (input.action === USDC_API_ACTION.COPY_EXAMPLE)
      this.copy(
        paypalAgentExample({ url: this.state.url, model: this.state.model }),
      );
    else throw new Error('Unsupported key action');
    return structuredClone(this.state);
  }
  async run(event: Sender, args: readonly unknown[]): Promise<UsdcApiState> {
    if (
      this.closed ||
      this.owner.destroyed() ||
      event.sender !== this.owner.contents ||
      event.senderFrame !== this.owner.mainFrame() ||
      args.length !== 1 ||
      !args[0] ||
      typeof args[0] !== 'object' ||
      Array.isArray(args[0])
    )
      throw new Error('Unsupported API key request');
    const input = Object.fromEntries(Object.entries(args[0]));
    const policy = this.current();
    if (!policy) return emptyUsdcApi();
    if (this.busy)
      return {
        ...structuredClone(this.state),
        error: 'A key action is in progress.',
      };
    this.busy = true;
    try {
      if (
        input.action === USDC_API_ACTION.STATUS &&
        Object.keys(input).length === 1
      )
        return await this.refresh();
      if (input.policyId !== policy.policyId)
        throw new Error('Buyer changed. Refresh first.');
      if (
        input.action === USDC_API_ACTION.PREVIEW_AGENT ||
        input.action === USDC_API_ACTION.COPY_AGENT ||
        input.action === USDC_API_ACTION.WRITE_AGENT
      )
        return await this.agentSetup(input);
      const { policyId: _policyId, ...command } = input;
      if (
        input.action === USDC_API_ACTION.CREATE ||
        input.action === USDC_API_ACTION.REVOKE
      )
        return await this.refresh(parseBuyerApiKeyCommand(command));
      return await this.copyConnection(input);
    } catch (error) {
      if (error instanceof AgentSetupError) {
        const { setup: _setup, ...state } = this.state;
        this.state = state;
      }
      return {
        ...structuredClone(this.state),
        error:
          error instanceof AgentSetupError &&
          error.code === AGENT_SETUP_CODES.ENDPOINT
            ? 'Could not read the models served by the local buyer. Start the buyer and refresh; no model was substituted.'
            : error instanceof AgentSetupError &&
                error.code === AGENT_SETUP_CODES.FILE
              ? 'The agent configuration has conflicting or unmanaged settings. Review it before writing; no conflicting file was overwritten.'
              : 'Could not confirm API key status. Check Payments and refresh before using the connection.',
      };
    } finally {
      this.busy = false;
    }
  }
  private async agentSetup(input: Record<string, unknown>) {
    const tool = Object.values(AGENT_TOOLS).find((tool) => tool === input.tool);
    const action = Object.values(USDC_API_ACTION).find(
      (action) => action === input.action,
    );
    if (
      Object.keys(input).sort().join(',') !== 'action,id,policyId,tool' ||
      !tool ||
      !action ||
      !this.client.agentEndpoint
    )
      throw new Error('Invalid agent setup');
    await this.refresh();
    const endpoint = await this.client.agentEndpoint();
    await this.refresh();
    if (
      this.closed ||
      this.client.policy()?.policyId !== input.policyId ||
      this.state.snapshot?.blocked ||
      !this.state.snapshot?.keys.some(
        (key) => key.id === input.id && !key.revoked,
      )
    )
      throw new Error('Agent key is unavailable');
    const setup = await prepareAgentSetup(
      tool,
      endpoint,
      action,
      this.copy,
      this.files,
    );
    this.state = { ...this.state, setup };
    return structuredClone(this.state);
  }
}
export function createUsdcApiHandlers(
  client: Client,
  owner: Owner,
  copy: (value: string) => void,
  files?: AgentSetupFiles,
) {
  return new UsdcApiHost(client, owner, copy, files);
}
