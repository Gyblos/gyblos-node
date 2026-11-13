import assert from 'node:assert/strict';

import { PaypalChatController } from '@gyblos/desktop/paypal-chat';
import { createDesktopPaypalHandlers } from '@gyblos/desktop/paypal-handlers';
import { createDesktopPaypalSession } from '@gyblos/desktop/paypal-session';
import { createPaypalSession } from '@gyblos/node/paypal-session';
import { validatePaypalPrompt } from '@gyblos/node/paypal-startup';

import { fixture } from './paypal-session-fixture';

export async function setup(confirmFinish = true) {
  const f = fixture();
  const opened: string[] = [];
  const states: string[] = [];
  const payment = {
    ...f.payment,
    async isApproved() {
      return f.payment.isApproved();
    },
    async authorize() {
      return f.payment.authorize();
    },
    async create(_requestId: string, state?: string) {
      assert.ok(state);
      states.push(state);
      return f.payment.create();
    },
  };
  const service = createDesktopPaypalSession(
    await createPaypalSession({
      ...f,
      payment,
      validateRequest: validatePaypalPrompt,
    }),
    async (url) => {
      opened.push(url);
    },
  );
  const contents = {};
  const frame = {};
  const handlers = createDesktopPaypalHandlers(
    async () => ({ service, model: 'qwen-test' }),
    {
      contents,
      mainFrame: () => frame,
      destroyed: () => false,
    },
    async () => false,
    async () => confirmFinish,
  );
  const event = { sender: contents, senderFrame: frame };
  const run = (request: unknown) => handlers.run(event, [request]);
  return {
    f,
    opened,
    run,
    service,
    states,
    chat: new PaypalChatController(run),
  };
}
