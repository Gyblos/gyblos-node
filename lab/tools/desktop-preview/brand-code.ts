// Swaps shipped code samples and connection state for the shared PreviewKit components, in the mockup bundle only.

import { replaceOnce } from './brand-replace';

export function transformCodeSamples(
  source: string,
  target: string,
  base: string,
): string | undefined {
  if (target === `${base}/src/ui/PaypalAgentConnection.tsx`)
    return (
      "import { Tag, TONE } from './PreviewKit';\n" +
      replaceOnce(
        source,
        '        <div className="ui-connection-state-label">\n          <CheckCircle size={18} aria-hidden="true" />\n          <span>Connection ready</span>\n        </div>',
        '        <Tag tone={TONE.SUCCESS} dot>Connection ready</Tag>',
      )
    );
  return undefined;
}
