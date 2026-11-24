export async function checkMinimumLayout() {
  const maxAttempts = 100;
  const pollMs = 50;
  const keyNameLength = 60;

  async function visible(selector: string) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const element = document.querySelector<HTMLElement>(selector);
      if (element?.getBoundingClientRect().width) return element;
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
  funding.balance = async (...args) => {
    const observed = await read(...args);
    return observed && { ...observed, balanceAtomic: '1234567890123456789' };
  };
  picker.click();
  const add = await visible('.pk-balance-add');
  const menu = add.closest('.compact-dropdown');
  fits(add, menu);
  const balance = await visible(
    '.pk-balance-line strong:not([data-unavailable])',
  );
  if (!balance.textContent.includes('1234567890123.456789'))
    throw new Error('Missing long balance');
  fits(balance, menu);
  picker.click();

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
  const iconOnlyWidth = 36;
  async function iconOnly(label: string) {
    const action = await visible('button[aria-label="' + label + '"]');
    if (action.getBoundingClientRect().width > iconOnlyWidth)
      throw new Error('Text action ' + label);
  }
  function apart(cells: Element[]) {
    const boxes = cells.map((cell) => cell.getBoundingClientRect());
    for (const [index, box] of boxes.entries())
      for (const other of boxes.slice(index + 1))
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
  const copies = Array.from(
    document.querySelectorAll('.preview-method-copy'),
    (copy) => copy.getBoundingClientRect().left,
  )
    .filter((left) => left < innerWidth)
    .map(Math.round);
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
