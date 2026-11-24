'use client';

import { CircleHelp } from 'lucide-react';
import { useState } from 'react';
import { Focusable } from 'react-aria-components';

import {
  Tooltip,
  TooltipTrigger,
} from '../boardui/components/base/tooltip/tooltip';
import { HELP_TRIGGER } from '../lib/constants';

export function SectionHelp({ title, text }: { title: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipTrigger {...HELP_TRIGGER} isOpen={open} onOpenChange={setOpen}>
      <Focusable>
        <button
          type="button"
          aria-label={`What ${title} shows`}
          onClick={() => setOpen((isOpen) => !isOpen)}
          className="flex cursor-help items-center text-dim outline-none hover:text-ink focus-visible:text-ink"
        >
          <CircleHelp aria-hidden className="size-4" />
        </button>
      </Focusable>
      <Tooltip size="md" placement="bottom" className="max-w-sm">
        {text}
      </Tooltip>
    </TooltipTrigger>
  );
}
