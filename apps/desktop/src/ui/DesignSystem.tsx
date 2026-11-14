// Demonstrates the shared buyer UI primitives without accessing account or payment state.
import { useState } from 'react';

import { PAYMENT_METHOD, type PaymentMethod } from '../paypal-model';
import { AssistantHeading, AssistantProgress } from './ChatMessageParts';
import { ChatUserMessage } from './ChatUserMessage';
import { BUTTON_VARIANT, MODELS } from './constants';
import { FormField, FormInput } from './Form';
import { PaymentMethodSelector } from './PaymentMethodSelector';
import { Badge, Button } from './UI';

export function DesignSystem() {
  const [selected, setSelected] = useState<PaymentMethod>(PAYMENT_METHOD.USDC);
  return (
    <div className="ui-design-preview">
      <section className="ui-section" aria-label="Colors">
        <h3 className="ui-subheading">Colors</h3>
        <div className="ui-swatch-list">
          <span className="ui-swatch ui-swatch--background">Background</span>
          <span className="ui-swatch ui-swatch--panel">Panel</span>
          <span className="ui-swatch ui-swatch--accent">Accent</span>
        </div>
      </section>
      <section className="ui-section" aria-label="Buttons and status">
        <h3 className="ui-subheading">Buttons and status</h3>
        <div className="ui-inline-actions">
          <Button variant={BUTTON_VARIANT.PRIMARY}>Primary</Button>
          <Button variant={BUTTON_VARIANT.SECONDARY}>Secondary</Button>
          <Button disabled>Disabled</Button>
          <Badge>Preview</Badge>
        </div>
      </section>
      <section className="ui-section" aria-label="Typography and spacing">
        <h3 className="ui-subheading">Typography and spacing</h3>
        <p>Geist is used for headings, labels and body text.</p>
        <p className="ui-help-text">
          Shared spacing: 4, 8, 12, 16, 24 and 32 pixels. Panels use a 16-pixel
          radius; controls use 10 pixels and options use 8 pixels.
        </p>
      </section>
      <section className="ui-section" aria-label="Inputs">
        <h3 className="ui-subheading">Inputs</h3>
        <FormField htmlFor="design-example" label="Example label">
          <FormInput id="design-example" placeholder="Type here" />
        </FormField>
      </section>
      <section className="ui-section" aria-label="Selection cards">
        <h3 className="ui-subheading">Selection cards</h3>
        <PaymentMethodSelector
          name="design-example-payment"
          label="Example payment method"
          value={selected}
          onChange={setSelected}
        />
      </section>
      <section className="ui-section" aria-label="Conversation">
        <h3 className="ui-subheading">Conversation</h3>
        <div className="chat-transcript">
          <ChatUserMessage text="Help me plan a small project." />
          <article className="chat-answer" aria-label="Assistant">
            <AssistantHeading
              model={MODELS[0].name}
              artwork={MODELS[0].image}
              badge={<Badge>Preview</Badge>}
            />
            <div className="reply-text">
              <p>Start with the outcome you want to achieve.</p>
            </div>
            <AssistantProgress>Generating response…</AssistantProgress>
          </article>
        </div>
      </section>
      <p className="ui-help-text">
        These examples do not change your payment method or start a session.
      </p>
    </div>
  );
}
