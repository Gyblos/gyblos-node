'use client';

// Copies the complete exported article, with accessible success/failure feedback and a direct fallback.
// Only a same-site static Markdown file is fetched; no content is sent to another service.
import { useState } from 'react';

export function PageActions({
  markdownUrl,
  spanish,
}: {
  markdownUrl: string;
  spanish: boolean;
}) {
  const [message, setMessage] = useState('');
  const [copying, setCopying] = useState(false);

  async function copyPage() {
    setCopying(true);
    setMessage('');
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
      setMessage(spanish ? 'Página copiada' : 'Page copied');
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
        <button type="button" onClick={copyPage} disabled={copying}>
          {copying
            ? spanish
              ? 'Copiando…'
              : 'Copying…'
            : spanish
              ? 'Copiar página'
              : 'Copy page'}
        </button>
        <a href={markdownUrl}>{spanish ? 'Ver Markdown' : 'View Markdown'}</a>
      </div>
      <p role="status" className="text-sm text-fd-muted-foreground">
        {message}
      </p>
    </div>
  );
}
