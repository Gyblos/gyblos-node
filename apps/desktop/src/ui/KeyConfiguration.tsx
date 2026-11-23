import { useEffect, useState } from 'react';

import type { AgentTool } from '@gyblos/node/agent-setup-constants';

import { USDC_API_ACTION } from '../usdc-api-model';
import { agentCodeLanguage, CodeBlock } from './CodeBlock';
import { Button } from './UI';
import type { useUsdcApiKeys } from './useUsdcApiKeys';

export function KeyConfiguration({
  api,
  id,
  tool,
  title,
  onCopied,
}: {
  api: ReturnType<typeof useUsdcApiKeys>;
  id: string;
  tool: AgentTool;
  title: string;
  onCopied(): void;
}) {
  const [code, setCode] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const { run, state, busy } = api;
  const policyId = state.policyId;
  useEffect(() => {
    let active = true;
    void run({ action: USDC_API_ACTION.PREVIEW_AGENT, id, tool }).then(
      (result) => {
        if (active)
          setCode(
            result &&
              !result.error &&
              result.policyId === policyId &&
              result.setup?.tool === tool
              ? result.setup.text
              : undefined,
          );
      },
    );
    return () => {
      active = false;
    };
  }, [id, tool, run, policyId, attempt]);
  if (!code)
    return (
      <Button disabled={busy} onClick={() => setAttempt((count) => count + 1)}>
        Refresh configuration
      </Button>
    );
  return (
    <CodeBlock
      language={agentCodeLanguage(tool)}
      title={title}
      code={code}
      copyDisabled={busy || !!state.error || !!state.snapshot?.blocked}
      onCopy={async () => {
        const result = await run({
          action: USDC_API_ACTION.COPY_AGENT,
          id,
          tool,
        });
        if (
          !result ||
          result.error ||
          result.policyId !== policyId ||
          result.setup?.tool !== tool
        )
          return false;
        onCopied();
        return true;
      }}
    />
  );
}
