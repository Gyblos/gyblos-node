export async function checkMinimumLayout() {
  async function visible(selector) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const element = document.querySelector(selector);
      if (element?.getBoundingClientRect().width) return element;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Missing ' + selector);
  }

  function fits(element, container) {
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

  document.startViewTransition = undefined;
  const picker = await visible('.ui-model-trigger');
  const read = window.desktopFunding.balance;
  window.desktopFunding.balance = async (...args) => {
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
  const row = await visible('section[aria-label="API key limits"] tbody tr');
  const name = row.querySelector('th');
  name.textContent = '界'.repeat(60);
  await document.fonts.ready;
  const region = row.closest('.preview-simple-table-region');
  fits(name, region);
  fits(row.querySelector('.preview-tabular'), region);
  fits(row.querySelector('button'), region);
  if (region.scrollWidth > region.clientWidth + 1)
    throw new Error('Key row overflow');
  if (document.documentElement.scrollWidth > innerWidth)
    throw new Error('Document overflow');
  (await visible('button[aria-label="Chat"]')).click();
  const expand = document.querySelector('button[aria-label="Expand sidebar"]');
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
  document.querySelector('button[aria-label="Collapse sidebar"]')?.click();

  document.documentElement.dataset.layoutPassed = String(innerWidth);
}
