'use client';

// Copies the complete exported article, with accessible success/failure feedback and a direct fallback.
// Copy fetches only same-site Markdown; the separate assistant menu hands off its canonical public URL.
import { useState } from 'react';

import { CheckIcon, CopyIcon, MarkdownIcon } from './action-icons';
import { AssistantMenu } from './assistant-menu';

export function PageActions({
  markdownUrl,
  spanish,
}: {
  markdownUrl: string;
  spanish: boolean;
}) {
  const [message, setMessage] = useState('');
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyPage() {
    setCopying(true);
    setMessage('');
    setCopied(false);
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      // Start clipboard access during the click so Safari retains the user gesture.
      const content = fetch(markdownUrl).then(async (response) => {
        if (!response.ok) throw new Error('Markdown unavailable');
        return response.text();
      });
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await Promise.all([
          content,
          navigator.clipboard.write([
            new ClipboardItem({
              'text/plain': content.then(
                (text) => new Blob([text], { type: 'text/plain' }),
              ),
            }),
          ]),
        ]);
      } else {
        await navigator.clipboard.writeText(await content);
      }
      setCopied(true);
    } catch {
      setMessage(
        spanish
          ? 'No se pudo copiar. Abre «Ver Markdown» para copiar el texto.'
          : 'Could not copy. Open “View Markdown” to copy the text.',
      );
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className="docs-page-actions">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="docs-action-button"
          type="button"
          onClick={copyPage}
          disabled={copying}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copying
            ? spanish
              ? 'Copiando…'
              : 'Copying…'
            : copied
              ? spanish
                ? 'Copiado'
                : 'Copied'
              : spanish
                ? 'Copiar página'
                : 'Copy page'}
        </button>
        <a className="docs-action-button" href={markdownUrl}>
          <MarkdownIcon />
          {spanish ? 'Ver Markdown' : 'View Markdown'}
        </a>
        <AssistantMenu markdownUrl={markdownUrl} spanish={spanish} />
      </div>
      <p role="status" className={message ? 'docs-copy-error' : 'sr-only'}>
        {message ||
          (copied ? (spanish ? 'Página copiada' : 'Page copied') : '')}
      </p>
    </div>
  );
}
