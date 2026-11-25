import { Check, Copy } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';

import {
  AGENT_TOOLS,
  type AgentTool,
} from '@gyblos/node/agent-setup-constants';

import {
  CODE_LANGUAGE,
  codeLanguageLabel,
  highlightCode,
  type CodeLanguage,
  type CodeToken,
} from './code-highlight';

const MAX_HIGHLIGHT_CHARACTERS = 4096;
const MAX_HIGHLIGHT_LINES = 128;
const COPY_FEEDBACK_MS = 1000;

function codeLines(tokens: CodeToken[]) {
  let line: CodeToken[] = [];
  const lines = [line];
  for (const token of tokens)
    token.text.split('\n').forEach((text, index) => {
      if (index > 0) {
        line = [];
        lines.push(line);
      }
      if (text) line.push({ ...token, text });
    });
  return lines;
}

export function CodeBlock({
  code,
  language,
  title,
  onCopy,
  copyDisabled = false,
}: {
  code: string;
  language: CodeLanguage;
  title?: string;
  onCopy?: () => Promise<unknown> | unknown;
  copyDisabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const lines = useMemo(
    () =>
      code.length <= MAX_HIGHLIGHT_CHARACTERS &&
      code.split('\n').length <= MAX_HIGHLIGHT_LINES
        ? codeLines(highlightCode(code, language))
        : null,
    [code, language],
  );
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => setCopied(false), [code]);
  return (
    <figure className="pk-code">
      <figcaption>
        <span className="pk-code-language">{codeLanguageLabel(language)}</span>
        {title && <span className="pk-code-title">{title}</span>}
        <button
          type="button"
          className="pk-code-copy"
          disabled={copyDisabled}
          aria-label={copied ? 'Copied' : 'Copy ' + (title ?? 'code')}
          onClick={() => {
            void Promise.resolve()
              .then(() =>
                onCopy ? onCopy() : navigator.clipboard.writeText(code),
              )
              .then((result) => setCopied(onCopy ? result === true : true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? (
            <Check size={14} aria-hidden="true" />
          ) : (
            <Copy size={14} aria-hidden="true" />
          )}
          {!copied && (
            <span aria-hidden="true">{copied ? 'Copied' : 'Copy'}</span>
          )}
        </button>
      </figcaption>
      <pre tabIndex={0}>
        <code>
          {lines === null
            ? code
            : lines.map((line, row) => (
                <span key={row} className="pk-code-line">
                  {line.map((token, index) =>
                    token.kind ? (
                      <span key={index} data-token={token.kind}>
                        {token.text}
                      </span>
                    ) : (
                      token.text
                    ),
                  )}
                  {row < lines.length - 1 && '\n'}
                </span>
              ))}
        </code>
      </pre>
    </figure>
  );
}
export function agentCodeLanguage(tool: AgentTool): CodeLanguage {
  if (tool === AGENT_TOOLS.CODEX) return CODE_LANGUAGE.TOML;
  if (tool === AGENT_TOOLS.CLAUDE_CODE) return CODE_LANGUAGE.SHELL;
  return CODE_LANGUAGE.JSON;
}
