'use client';

// Accessible handoff popover; its provider links do nothing until the reader chooses one.
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from 'fumadocs-ui/components/ui/popover';

import { getAssistantLinks } from '../lib/assistant-links';
import { ASSISTANT_IDS } from '../lib/constants';
import { AssistantIcon, ChevronIcon } from './action-icons';

export function AssistantMenu({
  markdownUrl,
  spanish,
}: {
  markdownUrl: string;
  spanish: boolean;
}) {
  return (
    <Popover>
      <PopoverTrigger className="docs-action-button">
        {spanish ? 'Abrir en' : 'Open in'}
        <ChevronIcon />
      </PopoverTrigger>
      <PopoverContent align="start" className="docs-assistant-menu">
        {getAssistantLinks(markdownUrl, spanish).map((assistant) => (
          <a
            key={assistant.id}
            href={assistant.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <AssistantIcon id={assistant.id} />
            <span>{assistant.name}</span>
            {assistant.id === ASSISTANT_IDS.CLAUDE_CODE && (
              <span className="docs-assistant-note">
                {spanish ? 'App de escritorio' : 'Desktop app'}
              </span>
            )}
          </a>
        ))}
      </PopoverContent>
    </Popover>
  );
}
