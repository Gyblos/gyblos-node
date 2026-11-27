export async function checkFailedTurn(
  reviewAction: string,
  paypalSend: string,
) {
  const maxAttempts = 80;
  const pollMs = 50;
  const example = new URLSearchParams(location.search).get('review');
  const wait = async (read: () => boolean, reason: string) => {
    for (let i = 0; i < maxAttempts; i++) {
      if (read()) return;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(reason);
  };
  const composer = () =>
    document.querySelector<HTMLTextAreaElement>('.chat-page textarea');
  const buttons = (selector: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>(selector)).filter(
      (el) => el.getBoundingClientRect().width > 0,
    );
  const button = (selector: string, label: string) =>
    buttons(selector).find((el) => el.textContent?.trim() === label);
  const alerts = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[role=status]')).filter(
      (el) => !el.closest('[inert]') && el.getBoundingClientRect().width > 0,
    );
  await wait(() => Boolean(composer()?.value), 'Missing restored draft');
  const reviewCase = new URLSearchParams(location.search).get('status-proof');
  if (reviewCase) {
    const buyer = window.desktopX402;
    if (!buyer) throw new Error('Missing buyer bridge');
    const run = buyer.run;
    let reviews = 0;
    buyer.run = async (request) => {
      const result = await run(request);
      if (
        !request ||
        typeof request !== 'object' ||
        !('action' in request) ||
        request.action !== reviewAction
      )
        return result;
      reviews++;
      if (
        !result.summary.records.length ||
        result.summary.records.some(
          (record) => record.id === 'interrupted-turn',
        )
      )
        throw new Error('Expected records belonging only to other turns');
      return {
        ...result,
        summary: { ...result.summary, blocked: false },
        ...(reviewCase === 'error' && { error: 'Synthetic review failure' }),
      };
    };
    const check = button('.chat-answer button', 'Check status');
    if (!check) throw new Error('Missing status check');
    check.click();
    await wait(() => reviews === 1, 'Status check did not run exactly once');
    const target =
      reviewCase === 'error'
        ? 'The status check was unavailable.'
        : 'The desktop budget reports no pending review.';
    await wait(
      () =>
        Boolean(
          document
            .querySelector('.chat-answer [role=status]')
            ?.textContent?.includes(target),
        ),
      'An unbound review claimed a recorded outcome',
    );
    const text = document.querySelector(
      '.chat-answer [role=status]',
    )?.textContent;
    if (!text?.includes('The charge for this turn remains unconfirmed.'))
      throw new Error('Turn certainty was lost');
  } else if (example === 'declined-turn') {
    const oldDraft = composer()!.value;
    const edit =
      button('.chat-answer button', 'Edit in new chat') ??
      button('.chat-answer button', 'Edit question');
    if (!edit) throw new Error('Missing edit action');
    edit.click();
    await wait(
      () => composer()?.value === 'How do I read a file in TypeScript?',
      'Edit did not open the refused question',
    );
    if (composer()?.readOnly || composer()?.disabled)
      throw new Error('Question is not editable');
    const archives = window.desktopConversations;
    if (!archives) throw new Error('Missing conversation archive');
    let saved = false;
    for (let i = 0; i < maxAttempts && !saved; i++) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const data = await archives.load();
      saved =
        !!data.archive &&
        data.archive.sessions.some(
          (session) =>
            session.id !== data.archive?.activeId && session.draft === oldDraft,
        ) &&
        data.archive.sessions.some(
          (session) =>
            session.id === data.archive?.activeId &&
            session.draft === composer()?.value,
        );
    }
    if (!saved) throw new Error('The newer draft was overwritten');
  } else {
    if (example === 'paypal-turn') {
      buttons('button[aria-label="Choose payment method"]')[0]?.click();
      await wait(
        () =>
          buttons('[role=menuitemradio]').some((el) =>
            el.textContent?.includes('PayPal'),
          ),
        'Missing PayPal option after picker',
      );
      const option = buttons('[role=menuitemradio]').find((el) =>
        el.textContent?.includes('PayPal'),
      );
      if (!option) throw new Error('Missing PayPal method');
      option.click();
      await wait(
        () =>
          !buttons('[role=menuitemradio]').some((el) =>
            el.textContent?.includes('PayPal'),
          ),
        'Payment menu open',
      );
      if (
        alerts().filter((el) => /interrupted/i.test(el.textContent ?? ''))
          .length !== 1
      )
        throw new Error('Duplicate PayPal failure announcement');
      const paypal = window.desktopPaypal;
      if (!paypal) throw new Error('Missing PayPal bridge');
      const run = paypal.run;
      const expectedTurns = 2;
      let sends = 0;
      paypal.run = async (request) => {
        if (request.action === paypalSend) {
          sends++;
          throw new Error('SYNTHETIC_PAYPAL_FAILURE_CANARY');
        }
        return run(request);
      };
      await wait(
        () => buttons('button[type=submit]').some((el) => !el.disabled),
        'Missing enabled PayPal send',
      );
      buttons('button[type=submit]')
        .find((el) => !el.disabled)!
        .click();
      await wait(
        () =>
          sends === 1 &&
          document.querySelectorAll('.chat-answer [role=status]').length ===
            expectedTurns,
        'Missing new failed PayPal turn',
      );
      if (
        document.querySelector('.paypal-chat-alert') ||
        document.body.innerText.includes('SYNTHETIC_PAYPAL_FAILURE_CANARY')
      )
        throw new Error('The new PayPal failure repeated outside its turn');
    }
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new Error('synthetic');
        },
      },
    });
    const copy = buttons('[aria-label="Copy message"]')[0];
    if (!copy) throw new Error('Missing Copy message');
    copy.click();
    await wait(
      () =>
        alerts().some((el) => el.textContent?.includes('Copy is unavailable')),
      'Independent copy failure hidden',
    );
    if (!document.querySelector('.chat-answer [role=status]'))
      throw new Error('Missing turn failure');
  }
  document.documentElement.dataset.recoveryPassed = 'yes';
}
