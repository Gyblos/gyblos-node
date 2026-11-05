// Shared user message presentation; it does not submit prompts or change sessions.
import type { ReactNode } from 'react';

export function ChatUserMessage({
  text,
  action,
}: {
  text: string;
  action?: ReactNode;
}) {
  return (
    <article className="chat-user" aria-label="You">
      <div>
        <span className="chat-message-role">You</span>
        <p>{text}</p>
      </div>
      {action}
    </article>
  );
}
