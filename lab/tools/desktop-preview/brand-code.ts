// Swaps shipped code samples and connection state for the shared PreviewKit components, in the mockup bundle only.

import { replaceBetween, replaceOnce } from './brand-replace';

export function transformCodeSamples(
  source: string,
  target: string,
  base: string,
): string | undefined {
  if (target === `${base}/src/ui/PaypalAgentSetup.tsx`)
    return (
      "import { CodeBlock } from './PreviewKit';\n" +
      replaceBetween(
        source,
        '            <p className="ui-help-text">\n              Set your app\'s base URL',
        '          </>\n        ) : (',
        `            <p className="ui-help-text">
              Point any OpenAI-compatible client at this base URL and key. Text
              and supported tool calls use Chat Completions.
            </p>
            {connection && (
              <CodeBlock
                language="shell"
                title="Example request"
                code={paypalAgentExample(connection)}
                copyDisabled={disabled}
                onCopy={() => copy(PAYPAL_AGENT_COPY.EXAMPLE, 'Example request')}
              />
            )}
            <p className="ui-help-text">
              Set GYBLOS_API_KEY privately in your terminal before running the
              example.
            </p>
`,
      )
    );
  if (target === `${base}/src/ui/PaypalAgentConnection.tsx`)
    return (
      "import { Tag, TONE } from './PreviewKit';\n" +
      replaceOnce(
        source,
        '        <div className="ui-connection-state-label">\n          <CheckCircle size={18} aria-hidden="true" />\n          <span>Connection ready</span>\n        </div>',
        '        <Tag tone={TONE.SUCCESS} dot>Connection ready</Tag>',
      )
    );
  if (target === `${base}/src/ui/MessageText.tsx`)
    return (
      "import { CodeBlock, fenceLanguage } from './PreviewKit';\n" +
      replaceOnce(
        source,
        '            <pre key={index}>\n              <code>{code}</code>\n            </pre>',
        "            <CodeBlock key={index} language={fenceLanguage(section)} code={code.replace(/\\n$/, '')} />",
      )
    );
  if (target === `${base}/src/ui/paypal-agent-connection-hook.ts`)
    return replaceOnce(
      replaceOnce(
        source,
        '    if (!connection) return;\n    const copied',
        '    if (!connection) return false;\n    const copied',
      ),
      "          : 'Could not copy. Check the connection and try again.',\n      );\n  }",
      "          : 'Could not copy. Check the connection and try again.',\n      );\n    return copied === true;\n  }",
    );
  return undefined;
}
