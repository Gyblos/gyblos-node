// Presents the two sides of a PayPal chat and its in-progress response.
// The display never starts inference or changes the payment session.
import { modelArtwork } from './announced-models';
import { AssistantHeading, AssistantProgress } from './ChatMessageParts';
import { ChatUserMessage } from './ChatUserMessage';

export function PaypalAssistantHeading({ model }: { model: string | null }) {
  return (
    <AssistantHeading
      artwork={modelArtwork(model ?? '')}
      model={model ?? 'Local model'}
    />
  );
}

export function PaypalPendingMessage({
  model,
  prompt,
}: {
  model: string | null;
  prompt: string;
}) {
  return (
    <>
      <ChatUserMessage text={prompt} />
      <article className="chat-answer paypal-answer" aria-label="Assistant">
        <PaypalAssistantHeading model={model} />
        <AssistantProgress>Generating response…</AssistantProgress>
      </article>
    </>
  );
}
