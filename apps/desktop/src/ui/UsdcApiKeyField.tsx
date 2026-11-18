// Reveals one delegated key only on request, retaining it solely while this field is visible.
// Hiding, scope changes and unmount invalidate late reads; nothing is written or copied implicitly.
import { Copy, Eye, EyeSlash } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

import { USDC_API_ACTION } from '../usdc-api-model';
import { BUTTON_VARIANT } from './constants';
import { FormInput } from './Form';
import { Button } from './UI';
import type { useUsdcApiKeys } from './useUsdcApiKeys';

function KeyFieldActions({
  visible,
  available,
  busy,
  toggle,
  copy,
}: {
  visible: boolean;
  available: boolean;
  busy: boolean;
  toggle: () => void;
  copy: () => void;
}) {
  return (
    <>
      <Button
        variant={BUTTON_VARIANT.GHOST}
        aria-label={visible ? 'Hide API key' : 'Show API key'}
        aria-pressed={visible}
        disabled={!available || (busy && !visible)}
        onClick={toggle}
      >
        {visible ? <EyeSlash size={16} /> : <Eye size={16} />}
      </Button>
      <Button
        variant={BUTTON_VARIANT.GHOST}
        aria-label="Copy API key"
        disabled={busy || !available}
        onClick={copy}
      >
        <Copy size={16} />
        Copy
      </Button>
    </>
  );
}
export function UsdcApiKeyField({
  api,
  id,
  available,
}: {
  api: ReturnType<typeof useUsdcApiKeys>;
  id: string;
  available: boolean;
}) {
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState(false);
  const [showing, setShowing] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setSecret(undefined);
    setShowing(false);
    setError(false);
    return () => {
      generation.current++;
    };
  }, [id, api.state.policyId, available]);
  const toggle = async () => {
    const current = ++generation.current;
    setSecret(undefined);
    setError(false);
    setShowing(!showing);
    if (showing) return;
    try {
      const value = await api.reveal(id);
      if (current === generation.current) setSecret(value);
    } catch {
      if (current === generation.current) {
        setShowing(false);
        setError(true);
      }
    }
  };
  const visible = available && showing;
  return (
    <div className="ui-field">
      <label htmlFor="usdc-tool-key">API key</label>
      <div className="ui-copy-field ui-copy-field--reveal">
        <FormInput
          id="usdc-tool-key"
          readOnly
          type={visible && secret ? 'text' : 'password'}
          value={visible && secret ? secret : 'Key saved in your tool'}
          autoComplete="off"
          spellCheck={false}
        />
        <KeyFieldActions
          visible={visible}
          available={available}
          busy={api.busy}
          toggle={() => {
            void toggle();
          }}
          copy={() => {
            void api.run({ action: USDC_API_ACTION.COPY_KEY, id });
          }}
        />
      </div>
      {error && (
        <p role="alert">
          The key could not be shown. Refresh its status and try again.
        </p>
      )}
    </div>
  );
}
