// Output helpers shared by the `gyblos` commands: issue lines and URLs reduced to their origin, because
// providers embed API keys in URL paths.
import type { NodeConfigIssue } from '@gyblos/node/node-config';
import type { NodeConfigWarning } from '@gyblos/node/node-config-resolve';

export const COLUMN = 22;
const DOCUMENT_PATH = '(file)';
const PATH_HIDDEN = '<path hidden>';
export const URL_HIDDEN = '<url hidden>';
const ROOT_PATH = '/';

export function issueLine(issue: NodeConfigIssue | NodeConfigWarning) {
  const where = issue.path || DOCUMENT_PATH;
  const position =
    'line' in issue && issue.line !== undefined
      ? ` line ${issue.line} column ${issue.column ?? 0}`
      : '';
  return `  ${issue.code.padEnd(COLUMN)} ${where}${position}\n`;
}

// scheme://host[:port] only; a path, query or fragment may hold a key (Alchemy /v2/<key>, QuickNode).
export function urlOrigin(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return URL_HIDDEN;
  }
  const hidden = url.pathname !== ROOT_PATH || url.search || url.hash;
  return hidden ? `${url.origin} ${PATH_HIDDEN}` : url.origin;
}
