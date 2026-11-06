// Builds assistant links from a generated Markdown path, never the reader's location or query string.
// Only a public documentation URL is handed off after the reader explicitly chooses a provider.
import { ASSISTANT_IDS, ASSISTANTS } from './constants';
import { siteUrl } from './shared';

export function getAssistantLinks(markdownPath: string, spanish: boolean) {
  const documentUrl = `${siteUrl}${markdownPath}`;
  const prompt = spanish
    ? `Lee ${documentUrl}. Quiero hacer preguntas sobre esta página.`
    : `Read ${documentUrl}. I want to ask questions about this page.`;
  return ASSISTANTS.map((assistant) => {
    const url = new URL(assistant.endpoint);
    url.searchParams.set(assistant.parameter, prompt);
    if (assistant.id === ASSISTANT_IDS.CHATGPT)
      url.searchParams.set('hints', 'search');
    return { id: assistant.id, name: assistant.name, url: url.href };
  });
}
