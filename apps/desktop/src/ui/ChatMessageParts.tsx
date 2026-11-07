// Shared assistant identity and progress presentation; execution remains with each chat.
import type { ReactNode } from 'react';

import { ModelImage, type ModelArtwork } from './ModelImage';
import { Avatar } from './UI';

export function AssistantHeading({
  model,
  artwork,
  badge,
}: {
  model: string;
  artwork: ModelArtwork;
  badge?: ReactNode;
}) {
  return (
    <header className="answer-heading">
      <Avatar>
        <ModelImage artwork={artwork} name={model} />
      </Avatar>
      <strong>Assistant</strong>
      <span>{model}</span>
      {badge}
    </header>
  );
}

export function AssistantProgress({
  children,
  mark,
}: {
  children: ReactNode;
  mark?: ReactNode;
}) {
  return (
    <div className="chat-progress" role="status">
      {mark ?? (
        <span className="chat-progress-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
      {children}
    </div>
  );
}
