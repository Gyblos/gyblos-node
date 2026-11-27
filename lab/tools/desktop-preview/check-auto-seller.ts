import type { ChannelBlocker } from '@gyblos/protocol/buyer-api';

import type { previewDesktopCatalog } from './seller-listings';

export async function checkAutoSeller(
  catalog: ReturnType<typeof previewDesktopCatalog> | undefined,
  model: string,
  inputAtomicPerMtok: string,
  outputAtomicPerMtok: string,
  affordable: boolean,
  replacement: ChannelBlocker,
  sendAction: string,
  partial = false,
  evidence?: 'zero' | 'unknown' | 'free',
) {
  const funding = window.desktopFunding;
  const buyer = window.desktopX402;
  if (!catalog || !funding || !buyer)
    throw new Error('Missing synthetic buyer');
  const original = catalog.summary;
  let expectedOffer: string | undefined;
  const seller = async () => {
    const snapshot = await original();
    const listing = snapshot.models.find(
      (item) => item.modelId === model && item.offerId,
    );
    if (!listing) throw new Error('Missing paid listing');
    expectedOffer = listing.offerId;
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
  catalog.summary = async () => {
    if (!partial) return seller();
    const snapshot = await original();
    const paid = snapshot.models.filter(
      (row) => row.modelId === model && row.offerId,
    );
    const first = paid.at(-1);
    if (!first || first.offerId === paid[0]?.offerId)
      throw new Error('Missing distinct overview seller');
    return {
      ...snapshot,
      truncated: true,
      models: [{ ...first, inputAtomicPerMtok: '100001' }],
    };
  };
  catalog.lookupAuto = async (query) => {
    const snapshot = await seller();
    const free =
      evidence === 'free' &&
      (await original()).models.find(
        (item) => item.modelId === model && item.free,
      );
    return {
      ...snapshot,
      query: String(query),
      models: free ? [free, ...snapshot.models] : snapshot.models,
      truncated: partial && (!affordable || !!evidence),
    };
  };
  let checked = 0;
  let sent = 0;
  const walletRead = funding.balance();
  funding.balance = async (offer) => {
    const wallet = await walletRead;
    if (!wallet) throw new Error('Missing wallet');
    if (offer) {
      if (offer !== expectedOffer)
        throw new Error('Funding read for the wrong signed listing');
      checked++;
    }
    if (offer && (evidence === 'zero' || evidence === 'unknown'))
      return {
        ...wallet,
        balanceAtomic: evidence === 'zero' ? '0' : null,
        faucetAvailable: evidence === 'zero',
        channelRemainingAtomic: null,
      };

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
  async function selectAuto() {
    const previous = document.querySelector('.toast')?.textContent;
    trigger.click();
    const auto = await until('Auto seller', () =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
      ).find((row) => row.textContent.includes('Auto · ' + model)),
    );
    auto.click();
    return until('selection result', () => {
      const notice = document.querySelector('.toast')?.textContent;
      return (
        notice && notice !== previous && !notice.includes('Checking') && notice
      );
    });
  }
  const decision = await selectAuto();
  if (evidence === 'zero' || evidence === 'unknown') {
    if (
      !decision.includes('partial') ||
      !decision.includes('Try again') ||
      checked !== 1 ||
      sent ||
      draft.value !== 'Synthetic Auto turn' ||
      document.querySelector('dialog[open]') ||
      !form.isConnected
    )
      throw new Error(
        'Incomplete funding evidence did not retain Chat for another lookup',
      );
    const beforeRetry = checked;
    evidence = undefined;
    const retried = await selectAuto();
    if (
      !retried.includes('Auto selected') ||
      checked !== beforeRetry + 1 ||
      sent ||
      draft.value !== 'Synthetic Auto turn'
    )
      throw new Error(
        'The same draft could not recheck newly verified funding',
      );
  } else if (!affordable) {
    if (
      !(partial
        ? decision.includes('partial')
        : decision.includes('Auto rates')) ||
      checked ||
      sent ||
      draft.value !== 'Synthetic Auto turn'
    )
      throw new Error(
        'Overpriced seller used switching credit or consumed the draft',
      );
  } else {
    if (
      !decision.includes('Auto selected') ||
      checked !== (evidence === 'free' ? 0 : 1)
    )
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
