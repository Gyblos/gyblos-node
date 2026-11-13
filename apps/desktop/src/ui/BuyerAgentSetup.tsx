// Connects coding agents to the existing buyer; the host discovers models and owns configuration writes.
// Only environment references and generated text cross this view, never API credentials.
import { useEffect, useState } from 'react';

import {
  AGENT_TOOLS,
  type AgentTool,
} from '@gyblos/node/agent-setup-constants';

import type { AgentSetupPreview } from '../agent-setup-model';
import { USDC_API_ACTION } from '../usdc-api-model';
import { USDC_AGENT_SETUP } from '../x402/constants';
import { BUTTON_VARIANT } from './constants';
import { FormActions, FormField } from './Form';
import { Modal } from './Modal';
import { Button } from './UI';
import type { useUsdcApiKeys } from './useUsdcApiKeys';

const labels: Record<AgentTool, string> = {
  [AGENT_TOOLS.OPENCODE]: 'OpenCode',
  [AGENT_TOOLS.PI]: 'pi',
  [AGENT_TOOLS.CODEX]: 'Codex CLI',
  [AGENT_TOOLS.CLAUDE_CODE]: 'Claude Code',
};

function AgentSetupActions({
  run,
  id,
  tool,
  busy,
  unavailable,
}: {
  run: ReturnType<typeof useUsdcApiKeys>['run'];
  id: string;
  tool: AgentTool;
  busy: boolean;
  unavailable: boolean;
}) {
  return (
    <FormActions align="start">
      <Button
        disabled={busy}
        onClick={() => {
          void run({ action: USDC_API_ACTION.PREVIEW_AGENT, id, tool });
        }}
      >
        Refresh models
      </Button>
      <Button
        disabled={unavailable}
        onClick={() => {
          void run({ action: USDC_API_ACTION.COPY_AGENT, id, tool });
        }}
      >
        Copy configuration
      </Button>
      {tool !== AGENT_TOOLS.CLAUDE_CODE && (
        <Button
          variant={BUTTON_VARIANT.PRIMARY}
          disabled={unavailable}
          onClick={() => {
            void run({ action: USDC_API_ACTION.WRITE_AGENT, id, tool });
          }}
        >
          Write configuration
        </Button>
      )}
    </FormActions>
  );
}

function AgentPreview({ preview }: { preview: AgentSetupPreview | undefined }) {
  if (!preview) return null;
  return (
    <>
      <p>Models: {preview.models.join(', ')}</p>
      <pre className="ui-code-block" aria-label="Generated agent configuration">
        {preview.text}
      </pre>
      {preview.path && (
        <p className="ui-help-text">
          Configuration file: {preview.path}. Existing settings are kept; the
          first backup ends in .before-gyblos.
        </p>
      )}
      {preview.backup && (
        <p role="status">Original configuration saved at {preview.backup}.</p>
      )}
    </>
  );
}

function AgentSetupDialog({
  api,
  id,
  close,
}: {
  api: ReturnType<typeof useUsdcApiKeys>;
  id: string;
  close: () => void;
}) {
  const [tool, setTool] = useState<AgentTool>(AGENT_TOOLS.CODEX);
  const { state, busy, run } = api;
  const preview = state.setup?.tool === tool ? state.setup : undefined;
  useEffect(() => {
    void run({ action: USDC_API_ACTION.PREVIEW_AGENT, id, tool });
  }, [id, tool, run]);
  const unavailable = busy || !!state.error || !preview;
  return (
    <Modal title="Connect an agent" close={close}>
      <FormField label="Agent" htmlFor="buyer-agent-tool">
        <select
          id="buyer-agent-tool"
          className="ui-input"
          value={tool}
          disabled={busy}
          onChange={(event) => {
            const chosen = Object.values(AGENT_TOOLS).find(
              (tool) => tool === event.target.value,
            );
            if (chosen) setTool(chosen);
          }}
        >
          {Object.values(AGENT_TOOLS).map((tool) => (
            <option key={tool} value={tool}>
              {labels[tool]}
            </option>
          ))}
        </select>
      </FormField>
      <p className="ui-help-text">
        Uses the models served by your local buyer. Your key's budget applies to
        every model and tool.
      </p>
      {state.error && (
        <p role="alert" className="chat-notice">
          {state.error}
        </p>
      )}
      <AgentPreview preview={preview} />
      <p className="ui-help-text">
        Set {USDC_AGENT_SETUP.tokenEnv} in the shell where you start the agent,
        using Copy API key. These files contain the variable name only. Keep
        Gyblos and the buyer running.
      </p>
      <AgentSetupActions
        run={run}
        id={id}
        tool={tool}
        busy={busy}
        unavailable={unavailable}
      />
    </Modal>
  );
}

export function BuyerAgentSetup({
  api,
  id,
  disabled,
}: {
  api: ReturnType<typeof useUsdcApiKeys>;
  id: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button disabled={disabled} onClick={() => setOpen(true)}>
        Connect agent
      </Button>
      {open && (
        <AgentSetupDialog api={api} id={id} close={() => setOpen(false)} />
      )}
    </>
  );
}
