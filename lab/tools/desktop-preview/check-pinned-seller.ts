import type { ChannelBlocker } from '@gyblos/protocol/buyer-api';

export async function checkPinnedSeller(
  closed: ChannelBlocker,
  keyReview: ChannelBlocker,
  reviewAction: string,
  sendAction: string,
) {
  const maxAttempts = 100;
  const pollMs = 40;
  async function until<T>(observe: () => T | null | undefined | false) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = observe();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error('Seller check timed out: ' + observe.toString());
  }
  async function click(label: string) {
    (
      await until(() =>
        Array.from(document.querySelectorAll('button')).find(
          (button) =>
            !button.disabled &&
            !button.closest('[inert]') &&
            button.getBoundingClientRect().width &&
            (button.textContent.trim() === label ||
              button.getAttribute('aria-label') === label),
        ),
      )
    ).click();
  }
  async function choosePaidSeller() {
    await click('Models');
    (
      await until(() =>
        Array.from(
          document.querySelectorAll<HTMLButtonElement>('.preview-model-head'),
        ).find((button) => button.textContent.includes('qwen3-0.6b')),
      )
    ).click();
    (
      await until(() =>
        document.querySelector<HTMLButtonElement>('button[aria-label*="83ce"]'),
      )
    ).click();
  }
  const funding = window.desktopFunding;
  const buyer = window.desktopX402;
  if (!funding || !buyer) throw new Error('Missing synthetic buyer');
  const wallet = await funding.balance();
  if (!wallet) throw new Error('Missing fixture');
  let blocker: ChannelBlocker | undefined;
  let hold: Promise<void> | undefined;
  const actions: unknown[] = [];
  funding.balance = async (offer) => {
    if (offer) await hold;
    return {
      ...wallet,
      balanceAtomic: blocker === keyReview ? null : '2000000',
      ...(offer && { channelBlocker: blocker }),
    };
  };
  const execute = buyer.run;
  buyer.run = async (input) => {
    if (input && typeof input === 'object' && 'action' in input) {
      actions.push(input.action);
      if (input.action === reviewAction) blocker = closed;
    }
    return execute(input);
  };
  await choosePaidSeller();
  await click('Use this model');
  await click('Confirm seller');
  await until(() => !document.querySelector('dialog[open]'));
  await click('Chat');
  const form = await until(() =>
    document.querySelector<HTMLFormElement>(
      '.chat-root:not([hidden]) form.composer',
    ),
  );
  const draft = form.querySelector('textarea');
  if (!draft) throw new Error('Missing draft');
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set?.call(draft, 'Keep this draft');
  draft.dispatchEvent(new Event('input', { bubbles: true }));
  const button = await until(() =>
    form.querySelector<HTMLButtonElement>(
      'button[type="submit"]:not(:disabled)',
    ),
  );
  let release: (() => void) | undefined;
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  blocker = closed;
  form.requestSubmit();
  form.requestSubmit();
  await until(() => button.disabled);
  if (!release) throw new Error('Missing status observation');
  release();
  await until(() =>
    document.querySelector('.composer-note')?.textContent.includes('closed'),
  );
  if (
    draft.value !== 'Keep this draft' ||
    actions.includes(sendAction) ||
    !button.disabled
  )
    throw new Error('Blocked seller consumed draft or sent request');
  blocker = keyReview;
  await choosePaidSeller();
  await click('Check payment channel');
  await until(() =>
    document
      .querySelector('dialog')
      ?.textContent.includes('Reserved by API key'),
  );
  await click('Refresh wallet');
  await until(() =>
    document
      .querySelector('dialog')
      ?.textContent.includes('Reserved by API key'),
  );
  if (actions.includes(reviewAction))
    throw new Error('Wallet refresh reconciled payment');
  await click('Check status');
  await until(() =>
    document.querySelector('dialog')?.textContent.includes('Settled'),
  );
  if (
    actions.filter((action) => action === reviewAction).length !== 1 ||
    actions.includes(sendAction)
  )
    throw new Error('Unexpected payment action during review');
  blocker = undefined;
  await click('Back to models');
  await until(() => !document.querySelector('dialog[open]'));
  await click('Chat');
  await until(() => !button.disabled);
  form.requestSubmit();
  form.requestSubmit();
  await until(() => actions.includes(sendAction));
  if (actions.filter((action) => action === sendAction).length !== 1)
    throw new Error('Duplicate verified send');
  document.documentElement.dataset.layoutPassed = 'verified';
}
