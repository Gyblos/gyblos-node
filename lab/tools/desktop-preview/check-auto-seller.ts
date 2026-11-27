import type { ChannelBlocker } from '@gyblos/protocol/buyer-api';

import type { previewDesktopCatalog } from './seller-listings';

export async function checkAutoSeller(
  catalog: ReturnType<typeof previewDesktopCatalog> | undefined,
  inputAtomicPerMtok: string,
  outputAtomicPerMtok: string,
  affordable: boolean,
  replacement: ChannelBlocker,
  sendAction: string,
) {
  const funding = window.desktopFunding;
  const buyer = window.desktopX402;
  if (!catalog || !funding || !buyer)
    throw new Error('Missing synthetic buyer');
  const original = catalog.summary;
  const model = 'qwen3-0.6b';
  const seller = async () => {
    const snapshot = await original();
    const listing = snapshot.models.find(
      (item) => item.modelId === model && item.offerId,
    );
    if (!listing) throw new Error('Missing paid listing');
    return {
      ...snapshot,
      models: [
        {
          ...listing,
          inputAtomicPerMtok,
          outputAtomicPerMtok,
        },
      ],
    };
  };
  catalog.summary = seller;
  catalog.lookup = seller;
  let checked = 0;
  let sent = 0;
  const walletRead = funding.balance();
  funding.balance = async (offer) => {
    const wallet = await walletRead;
    if (!wallet) throw new Error('Missing wallet');
    if (offer) checked++;
    return {
      ...wallet,
      channelRemainingAtomic: null,
      ...(offer && { channelBlocker: replacement, switchingAtomic: '20000' }),
    };
  };
  const run = buyer.run;
  buyer.run = async (input) => {
    if (
      input &&
      typeof input === 'object' &&
      'action' in input &&
      input.action === sendAction
    ) {
      if (
        !(
          'auto' in input &&
          input.auto === true &&
          'model' in input &&
          input.model === model
        ) ||
        'offerId' in input
      )
        throw new Error('Expected a model-scoped Auto send');
      sent++;
    }
    const result = await run(input);
    if (!result.policy) return result;
    return {
      ...result,
      policy: {
        ...result.policy,
        paidAuto: true,
        autoPrices: {
          inputAtomicPerMtok: '100000',
          outputAtomicPerMtok: '200000',
        },
        autoRoutes: [{ id: model, modelId: model, maxTokens: 64 }],
      },
    };
  };
  const maxAttempts = 100;
  const pollMs = 40;
  async function until<T>(
    name: string,
    read: () => T | null | undefined | false,
  ) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = read();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error('Timed out waiting for ' + name);
  }
  await until('buyer ready', () =>
    document.querySelector('.pk-composer-tab [aria-busy="false"] .sr-only'),
  );
  const form = await until('chat', () =>
    document.querySelector<HTMLFormElement>(
      '.chat-root:not([hidden]) form.composer',
    ),
  );
  const draft = form.querySelector('textarea');
  if (!draft) throw new Error('Missing draft');
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set?.call(draft, 'Synthetic Auto turn');
  draft.dispatchEvent(new Event('input', { bubbles: true }));
  const trigger = await until('model menu', () =>
    form.querySelector<HTMLButtonElement>('.ui-model-trigger'),
  );
  trigger.click();
  const auto = await until('Auto seller', () =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ).find((row) => row.textContent.includes('Auto · ' + model)),
  );
  auto.click();
  const decision = await until('selection result', () => {
    const notice = document.querySelector('.toast')?.textContent;
    return notice && !notice.includes('Checking') && notice;
  });
  if (!affordable) {
    if (
      !decision.includes('Auto rates') ||
      checked ||
      sent ||
      draft.value !== 'Synthetic Auto turn'
    )
      throw new Error(
        'Overpriced seller used switching credit or consumed the draft',
      );
  } else {
    if (!decision.includes('Auto selected') || checked !== 1)
      throw new Error('Affordable switch rejected: ' + decision);
    const submit = await until('enabled send', () =>
      form.querySelector<HTMLButtonElement>(
        'button[type="submit"]:not(:disabled)',
      ),
    );
    submit.click();
    await until('Auto send', () => sent === 1);
  }
  document.documentElement.dataset.layoutPassed = 'verified';
}
