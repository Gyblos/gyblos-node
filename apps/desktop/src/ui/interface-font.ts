const FONT_KEY = 'gyblos-interface-font';
export function restoreInterfaceFont() {
  try {
    const font = localStorage.getItem(FONT_KEY);
    if (font === 'inter' || font === 'instrument')
      document.documentElement.dataset.font = font;
  } catch {
    return;
  }
}
export function setInterfaceFont(value: string) {
  const font = value === 'Inter' ? 'inter' : 'instrument';
  document.documentElement.dataset.font = font;
  try {
    localStorage.setItem(FONT_KEY, font);
  } catch {
    return;
  }
}
