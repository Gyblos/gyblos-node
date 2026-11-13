// Synthetic conversations and provider expectations; contents stay in this child and never enter reports.
import { RECEIPT_ACCEPTANCE } from './receipt-constants';
import { TOOL_ACCEPTANCE } from './tools-constants';

export const TOOL_FIXTURE = {
  name: 'get_time',
  id: 'call_synthetic',
  arguments: '{"zone":"UTC"}',
  result: '12:00',
  system: 'Answer with synthetic time only.',
  prior: 'This is a synthetic test.',
  previous: 'Ready.',
  question: 'Time in UTC?',
  final: '12:00 UTC',
  schema: {
    type: 'object',
    properties: { zone: { type: 'string' } },
    required: ['zone'],
    additionalProperties: false,
  },
} as const;
const call = () => ({
  id: TOOL_FIXTURE.id,
  type: 'function',
  function: { name: TOOL_FIXTURE.name, arguments: TOOL_FIXTURE.arguments },
});
export function toolRequest(
  anthropic: boolean,
  stream: boolean,
  followup = false,
) {
  const history = [
    { role: 'user', content: TOOL_FIXTURE.prior },
    { role: 'assistant', content: TOOL_FIXTURE.previous },
    { role: 'user', content: TOOL_FIXTURE.question },
  ];
  const completed = anthropic
    ? [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: TOOL_FIXTURE.id,
              name: TOOL_FIXTURE.name,
              input: { zone: 'UTC' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: TOOL_FIXTURE.id,
              content: TOOL_FIXTURE.result,
            },
          ],
        },
      ]
    : [
        { role: 'assistant', content: null, tool_calls: [call()] },
        {
          role: 'tool',
          tool_call_id: TOOL_FIXTURE.id,
          content: TOOL_FIXTURE.result,
        },
      ];
  return {
    model: RECEIPT_ACCEPTANCE.modelId,
    max_tokens: TOOL_ACCEPTANCE.maxTokens,
    stream,
    ...(anthropic ? { system: TOOL_FIXTURE.system } : {}),
    tools: anthropic
      ? [{ name: TOOL_FIXTURE.name, input_schema: TOOL_FIXTURE.schema }]
      : [
          {
            type: 'function',
            function: {
              name: TOOL_FIXTURE.name,
              parameters: TOOL_FIXTURE.schema,
            },
          },
        ],
    tool_choice: followup
      ? anthropic
        ? { type: 'none' }
        : 'none'
      : anthropic
        ? { type: 'tool', name: TOOL_FIXTURE.name }
        : { type: 'function', function: { name: TOOL_FIXTURE.name } },
    messages: [
      ...(anthropic ? [] : [{ role: 'system', content: TOOL_FIXTURE.system }]),
      ...history,
      ...(followup ? completed : []),
    ],
  };
}
export function providerExpectation(followup: boolean) {
  const input = toolRequest(false, false, followup);
  return { ...input, stream: true, stream_options: { include_usage: true } };
}
