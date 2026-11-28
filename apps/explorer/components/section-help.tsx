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
          className="flex size-11 shrink-0 cursor-help items-center justify-center rounded-md text-dim transition-colors duration-150 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal sm:pointer-fine:size-auto"
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
