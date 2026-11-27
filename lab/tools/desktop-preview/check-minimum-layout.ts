export async function checkMinimumLayout() {
  const maxAttempts = 100;
  const pollMs = 50;
  const keyNameLength = 60;

  function liveElement(selector: string) {
    return Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
      (candidate) =>
        !candidate.closest('[inert]') && candidate.getBoundingClientRect().width,
    );
  }

  async function visible(selector: string) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const element = liveElement(selector);
      if (element) return element;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error('Missing ' + selector);
  }

  function fits(element: Element | null, container: Element | null) {
    if (!element || !container) throw new Error('Missing layout element');
    const box = element.getBoundingClientRect();
    const bounds = container.getBoundingClientRect();
    if (
      box.left < bounds.left - 1 ||
      box.right > bounds.right + 1 ||
      box.left < 0 ||
      box.right > innerWidth + 1 ||
      box.width === 0
    )
      throw new Error('Clipped ' + element.tagName);
  }

  Object.defineProperty(document, 'startViewTransition', { value: undefined });
  const picker = await visible('.ui-model-trigger');
  const funding = window.desktopFunding;
  if (!funding) throw new Error('Missing funding bridge');
  const read = funding.balance;
  const settled = await read();
  if (!settled) throw new Error('Missing funding observation');
  let release: ((value: Awaited<ReturnType<typeof read>>) => void) | undefined;
  const pending = new Promise<Awaited<ReturnType<typeof read>>>((resolve) => {
    release = resolve;
  });
  funding.balance = () => pending;
  picker.click();
  const spinner = await visible('.pk-composer-tab .ui-inline-spinner');
  const live = spinner.closest('.pk-tab-item');
  if (!live) throw new Error('Missing live balance region');
  if (
    live.getAttribute('aria-live') !== 'polite' ||
    live.getAttribute('aria-busy') !== 'true' ||
    !live.textContent?.includes('Checking balance…')
  )
    throw new Error('Missing checking balance state');
  fits(spinner, live);
  const actions = await visible('.preview-menu-actions');
  const menu = actions.closest('.compact-dropdown');
  if (!menu) throw new Error('Missing model menu');
  if (menu.querySelector('.pk-balance-line'))
    throw new Error('Duplicated picker balance');
  const labels = Array.from(
    actions.querySelectorAll('.dropdown-footer'),
    (item) => item.textContent?.trim(),
  );
  if (labels.join('|') !== 'Add funds|View all models')
    throw new Error('Missing compact funds actions');
  for (const action of Array.from(actions.querySelectorAll('.dropdown-footer')))
    fits(action, menu);
  if (!release) throw new Error('Missing balance release');
  release({ ...settled, balanceAtomic: '1234567890123456789' });
  funding.balance = read;
  const balance = await visible(
    '.pk-composer-tab .pk-tab-item[aria-busy="false"]',
  );
  if (!balance.textContent.includes('1234567890123.456789'))
    throw new Error('Missing long balance');
  if (balance.querySelector('.ui-inline-spinner'))
    throw new Error('Balance spinner did not resolve');
  fits(balance, balance.closest('.pk-composer-tab'));
  picker.click();

  let releaseReturn:
    ((value: Awaited<ReturnType<typeof read>>) => void) | undefined;
  const returning = new Promise<Awaited<ReturnType<typeof read>>>((resolve) => {
    releaseReturn = resolve;
  });
  funding.balance = () => returning;

  (await visible('button[aria-label="Usage & payments"]')).click();
  (await visible('#preview-tab-limits')).click();
  const track = await visible('.pk-segmented-track');
  fits(track, track.closest('section'));
  const input = await visible('#chat-limit-amount:not(:disabled)');
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  if (!setter) throw new Error('Missing input setter');
  setter.call(input, '1');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const controls = input.closest('.preview-setting-control');
  if (!controls) throw new Error('Missing budget controls');
  await visible('.preview-setting-control > button:last-child');
  for (const control of Array.from(controls.querySelectorAll('input,button')))
    fits(control, controls.closest('section'));
  const row = await visible('section[aria-label="API key limits"] tbody tr');
  const name = row.querySelector('th');
  if (!name) throw new Error('Missing key name');
  name.textContent = '界'.repeat(keyNameLength);
  await document.fonts.ready;
  const region = row.closest('.preview-simple-table-region');
  if (!region) throw new Error('Missing key region');
  fits(name, region);
  fits(row.querySelector('.preview-tabular'), region);
  fits(row.querySelector('button'), region);
  if (region.scrollWidth > region.clientWidth + 1)
    throw new Error('Key row overflow');
  if (document.documentElement.scrollWidth > innerWidth)
    throw new Error('Document overflow');
  async function iconOnly(label: string) {
    const action = await visible('button[aria-label="' + label + '"]');
    const frame = action.closest('.desktop-frame');
    if (!frame) throw new Error('Missing frame');
    const size = parseFloat(
      getComputedStyle(frame).getPropertyValue('--control-size'),
    );
    const box = action.getBoundingClientRect();
    if (
      Math.round(box.width) !== Math.round(size) ||
      Math.round(box.height) !== Math.round(size)
    )
      throw new Error(
        'Text action ' + label + ' ' + box.width + 'x' + box.height,
      );
    const text = action.querySelector('.ui-action-label');
    if (!text || text.getBoundingClientRect().width > 1)
      throw new Error('Visible label ' + label);
    const tip = action.nextElementSibling;
    if (
      !tip?.matches('.ui-tooltip') ||
      getComputedStyle(tip).display === 'none'
    )
      throw new Error('Missing tooltip ' + label);
  }
  function apart(cells: Element[]) {
    const boxes = cells.map((cell) =>
      [cell, ...Array.from(cell.querySelectorAll('*'))]
        .filter((part) => part.checkVisibility({ visibilityProperty: true }))
        .map((part) => part.getBoundingClientRect())
        .filter((box) => box.width && box.height),
    );
    for (const [index, parts] of boxes.entries())
      for (const box of parts)
        for (const other of boxes.slice(index + 1).flat())
          if (
            box.left < other.right - 1 &&
            other.left < box.right - 1 &&
            box.top < other.bottom - 1 &&
            other.top < box.bottom - 1
          )
            throw new Error('Overlapping cells');
  }
  await iconOnly('Manage keys');
  (await visible('#preview-tab-overview')).click();
  await iconOnly('Spending limits');
  const rows = Array.from(document.querySelectorAll('.preview-method-copy'));
  const copies = rows
    .filter((copy) => !copy.closest('[inert]'))
    .map((copy) => Math.round(copy.getBoundingClientRect().left));
  document.documentElement.dataset.inertPaymentRows = String(
    rows.length - copies.length,
  );
  if (copies.length < 2) throw new Error('Missing payment methods');
  if (new Set(copies).size > 1) throw new Error('Misaligned payment methods');
  (await visible('#preview-tab-history')).click();
  await visible('.ui-table-region tbody tr');
  for (const row of Array.from(
    document.querySelectorAll('.ui-table-region tbody tr'),
  ))
    apart(Array.from(row.children));
  (await visible('button[aria-label="Models"]')).click();
  await iconOnly('Find network models');
  const toolbar = await visible('.ui-page .ui-toolbar');
  for (const control of Array.from(
    toolbar.querySelectorAll(':scope > :is(.ui-search, button)'),
  ))
    fits(control, toolbar);
  if (document.documentElement.scrollWidth > innerWidth)
    throw new Error('Models overflow');
  (await visible('button[aria-label="Chat"]')).click();
  if (liveElement('.pk-composer-tab .pk-tab-item[aria-busy="false"]'))
    throw new Error('Stale balance presented during revalidation');
  const rechecking = await visible('.pk-composer-tab .ui-inline-spinner');
  const recheckLive = rechecking.closest('.pk-tab-item');
  if (
    recheckLive?.getAttribute('aria-busy') !== 'true' ||
    !recheckLive.textContent?.includes('Checking balance…')
  )
    throw new Error('Missing revalidation checking state');
  if (!releaseReturn) throw new Error('Missing revalidation release');
  releaseReturn({ ...settled, balanceAtomic: '3000000' });
  funding.balance = read;
  const refreshed = await visible(
    '.pk-composer-tab .pk-tab-item[aria-busy="false"]',
  );
  if (
    !refreshed.textContent?.includes('Balance · last checked ·') ||
    !refreshed.textContent.includes('3 USDC')
  )
    throw new Error('Missing accessible refreshed balance');
  const expand = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Expand sidebar"]',
  );
  if (expand) expand.click();
  (await visible('button[aria-label="Search conversations"]')).click();
  const search = await visible('input[aria-label="Search conversations"]');
  let escaped = false;
  const onEscape = () => {
    escaped = true;
  };
  window.addEventListener('keydown', onEscape);
  search.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  window.removeEventListener('keydown', onEscape);
  await visible('button[aria-label="Search conversations"]');
  if (escaped || search.isConnected)
    throw new Error('History search did not consume Escape');
  document
    .querySelector<HTMLButtonElement>('button[aria-label="Collapse sidebar"]')
    ?.click();

  document.documentElement.dataset.layoutPassed = String(innerWidth);
}

export async function checkWideDialogAction() {
  const maxAttempts = 100;
  const pollMs = 50;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const action = document.querySelector(
      'dialog button[aria-label="Spending limits"]',
    );
    const text = action?.querySelector('.ui-action-label');
    if (text && text.getBoundingClientRect().width > 1) {
      const tip = action?.nextElementSibling;
      if (!tip?.matches('.ui-tooltip'))
        throw new Error('Missing tooltip Spending limits');
      action?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      if (getComputedStyle(tip).display !== 'none')
        throw new Error('Tooltip beside label Spending limits');
      document.documentElement.dataset.layoutPassed = String(innerWidth);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error('Missing dialog action');
}
