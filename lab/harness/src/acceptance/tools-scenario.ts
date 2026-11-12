// Runs one fresh tool scenario through product startup and selection; only engine capability is varied for refusal.
import { readFile } from 'node:fs/promises';

import { startBuyer } from '@gyblos/buyer/buyer-main';
import { PAID_BUYER } from '@gyblos/buyer/constants';
import { HTTP_STATUS, rolePathIn } from '@gyblos/config';
import { createSellerEngine } from '@gyblos/node/engine-registry';
import { GYBLOS_ALPN, P2P_ROLES } from '@gyblos/protocol/constants';

import { acceptanceAssert } from './errors';
import { receiptBody } from './receipt-http';
import { receiptWait, startReceiptScenario } from './receipt-startup';
import {
  TOOL_ACCEPTANCE,
  TOOL_ACCEPTANCE_CASES,
  type ToolAcceptanceCase,
  type ToolCaseReport,
} from './tools-constants';
import { toolRequest } from './tools-fixtures';
import { toolHttp, verifyToolAnswer } from './tools-http';
import { createToolProvider } from './tools-provider';

const positive = (scenario: ToolAcceptanceCase) =>
  [
    TOOL_ACCEPTANCE_CASES.OPENAI_JSON,
    TOOL_ACCEPTANCE_CASES.OPENAI_STREAM,
    TOOL_ACCEPTANCE_CASES.ANTHROPIC_JSON,
    TOOL_ACCEPTANCE_CASES.ANTHROPIC_STREAM,
  ].some((value) => value === scenario);
function invalidBody(scenario: ToolAcceptanceCase) {
  const body = toolRequest(false, false);
  if (scenario === TOOL_ACCEPTANCE_CASES.SCHEMA)
    return {
      ...body,
      tools: [
        { type: 'function', function: { name: 'get_time', parameters: 42 } },
      ],
    };
  if (scenario === TOOL_ACCEPTANCE_CASES.CHOICE)
    return {
      ...body,
      tool_choice: { type: 'function', function: { name: 'unoffered_tool' } },
    };
  if (scenario === TOOL_ACCEPTANCE_CASES.SEQUENCE)
    return {
      ...body,
      messages: [{ role: 'tool', tool_call_id: 'missing', content: '12:00' }],
    };
  return body;
}
export async function toolScenario(
  scenario: ToolAcceptanceCase,
  signal: AbortSignal,
): Promise<ToolCaseReport> {
  const provider = createToolProvider(scenario);
  let forbiddenCalls = 0;
  const forbidden = async (): Promise<never> => {
    forbiddenCalls++;
    throw new Error('Forbidden financial factory');
  };
  const automatic = scenario === TOOL_ACCEPTANCE_CASES.AUTOMATIC;
  const run = await startReceiptScenario(signal, {
    provider,
    maxTokens: TOOL_ACCEPTANCE.maxTokens,
    seller: {
      payments: forbidden,
      ...(scenario === TOOL_ACCEPTANCE_CASES.UNSUPPORTED
        ? {
            createEngine: (offer, dependencies) => {
              const prepared = createSellerEngine(offer, dependencies);
              // No product adapter currently advertises false: vary only its capability port, never generate/selection/execution.
              return {
                ...prepared,
                engine: { ...prepared.engine, supportsTools: () => false },
              };
            },
          }
        : {}),
    },
    ...(automatic
      ? {
          buyerStart: (options) =>
            startBuyer({ ...options, chain: forbidden, meter: forbidden }),
        }
      : {}),
  });
  try {
    acceptanceAssert(provider.calls() === 0 && run.binding.dials() === 0);
    const anthropic =
      scenario === TOOL_ACCEPTANCE_CASES.ANTHROPIC_JSON ||
      scenario === TOOL_ACCEPTANCE_CASES.ANTHROPIC_STREAM;
    const streaming =
      scenario === TOOL_ACCEPTANCE_CASES.OPENAI_STREAM ||
      scenario === TOOL_ACCEPTANCE_CASES.ANTHROPIC_STREAM;
    const url = anthropic
      ? run.buyer().url.replace('/v1/chat/completions', '/v1/messages')
      : run.buyer().url;
    if (positive(scenario)) {
      for (const followup of [false, true]) {
        const response = await toolHttp(
          url,
          toolRequest(anthropic, streaming, followup),
          signal,
        ).response;
        await verifyToolAnswer(response, anthropic, streaming, followup);
      }
      acceptanceAssert(
        provider.calls() === 2 &&
          provider.verifiedTurns() === 2 &&
          run.binding.dials() === 2 &&
          run.binding.beforeFirst() === 0,
      );
      acceptanceAssert(
        run.discoveryReads() >= 2 &&
          run.registry.counts().reads > 0 &&
          run.binding.controlDials() >= 2,
      );
    } else if (scenario === TOOL_ACCEPTANCE_CASES.CANCEL) {
      const outgoing = toolHttp(url, toolRequest(false, true), signal);
      const completion = outgoing.response.then(receiptBody).catch(() => '');
      await receiptWait(() => provider.calls() === 1, signal);
      outgoing.cancel();
      await completion;
      await receiptWait(() => provider.cancellations() > 0, signal);
      provider.release();
      acceptanceAssert(provider.calls() === 1 && run.binding.dials() === 1);
    } else {
      const token = automatic
        ? (
            await readFile(
              rolePathIn(
                run.environment,
                P2P_ROLES.BUYER,
                PAID_BUYER.tokenFile,
              ),
              'utf8',
            )
          ).trim()
        : undefined;
      const response = await toolHttp(
        url,
        scenario === TOOL_ACCEPTANCE_CASES.CUT
          ? toolRequest(false, true)
          : invalidBody(scenario),
        signal,
        token,
      ).response;
      const body = await receiptBody(response);
      const executed =
        scenario === TOOL_ACCEPTANCE_CASES.PROVIDER ||
        scenario === TOOL_ACCEPTANCE_CASES.CUT;
      acceptanceAssert(
        response.statusCode !== HTTP_STATUS.ok &&
          !body.includes('"tool_calls":['),
      );
      acceptanceAssert(
        provider.calls() === (executed ? 1 : 0) &&
          run.binding.dials() === (executed ? 1 : 0),
      );
      if (executed)
        acceptanceAssert(response.headers['x-should-retry'] === 'false');
      else if (scenario !== TOOL_ACCEPTANCE_CASES.UNSUPPORTED)
        acceptanceAssert(
          response.statusCode === HTTP_STATUS.badRequest &&
            run.binding.controlDials() === 0,
        );
    }
    // Closing drains receipt work and aborts late provider activity before final no-retry counters are sampled.
    await run.close();
    acceptanceAssert(
      run.externalCalls() === 0 &&
        run.registry.counts().forbidden === 0 &&
        forbiddenCalls === 0,
    );
    acceptanceAssert(
      run.binding.protocols().every((values) => !values.includes(GYBLOS_ALPN)),
    );
    return {
      case: scenario,
      generations: provider.calls(),
      executionDials: run.binding.dials(),
      controlConnections: run.binding.controlDials(),
      discoveryReads: run.discoveryReads(),
      registryReads: run.registry.counts().reads,
      cancellations: provider.cancellations(),
      verifiedTurns: provider.verifiedTurns(),
      forbiddenCalls,
    };
  } finally {
    await run.close();
  }
}
