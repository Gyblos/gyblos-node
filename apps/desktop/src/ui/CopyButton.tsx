// Provides compact, explicit copy feedback without reading clipboard contents.
import { Check, Copy } from '@phosphor-icons/react';
import { useState } from 'react';

import {
  COPY_RESULT,
  writeClipboardText,
  type ClipboardWriter,
  type CopyResult,
} from './clipboard';
import { IconButton } from './UI';

export function CopyButton({
  value,
  label,
  writeText,
}: {
  value: string;
  label: string;
  writeText?: ClipboardWriter['writeText'];
}) {
  const [copying, setCopying] = useState(false);
  const [result, setResult] = useState<CopyResult | null>(null);
  async function copy() {
    if (copying) return;
    setCopying(true);
    setResult(null);
    const outcome = await writeClipboardText(
      value,
      writeText ? { writeText } : navigator.clipboard,
    );
    setResult(outcome);
    setCopying(false);
  }
  const copied = result === COPY_RESULT.COPIED;
  const failed = result === COPY_RESULT.UNAVAILABLE;
  return (
    <span className="ui-copy-action">
      <IconButton
        label={label}
        title={copied ? 'Copied' : label}
        disabled={copying}
        onClick={() => void copy()}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </IconButton>
      <span
        role="status"
        className={failed ? 'ui-copy-error' : 'visually-hidden'}
      >
        {copied
          ? 'Copied'
          : failed
            ? 'Could not copy. Select the text and copy it.'
            : ''}
      </span>
    </span>
  );
}
