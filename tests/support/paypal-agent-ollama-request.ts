import { MODEL } from '@gyblos/engine-ollama/constants';

export const request = {
  model: MODEL.name,
  messages: [
    { role: 'system', content: 'synthetic instruction' },
    { role: 'user', content: 'synthetic request' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'read_file',
        parameters: { type: 'object', properties: {} },
      },
    },
  ],
  max_tokens: 128,
  stream: true,
};
