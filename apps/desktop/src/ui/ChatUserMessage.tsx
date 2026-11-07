// Shared user bubble with send time and actions below it; never submits a prompt.
import type { ReactNode } from 'react';

export function ChatUserMessage({
  text,
  sentAt = null,
  action,
}: {
  text: string;
  sentAt?: number | null;
  action?: ReactNode;
}) {
  const date = sentAt === null ? null : new Date(sentAt);
  return (
    <article className="chat-user-message" aria-label="You">
      <div className="chat-user">
        <p>{text}</p>
      </div>
      {(date || action) && (
        <footer className="chat-user-actions">
          {date && (
            <time dateTime={date.toISOString()} title={date.toLocaleString()}>
              {date.toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
          )}
          {action}
        </footer>
      )}
    </article>
  );
}
