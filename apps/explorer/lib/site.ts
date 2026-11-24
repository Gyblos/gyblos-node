// Owns what the explorer says about itself to search engines and AI answer engines: its canonical
// origin, title and description, shared by the page metadata, robots, sitemap and
// llms.txt. Public on purpose; no secrets.
export const SITE = {
  origin: 'https://explorer.gyblos.com',
  name: 'Gyblos Explorer',
  title: 'Gyblos Explorer — live metrics of the Gyblos AI inference network',
  description:
    'Live, public metrics of the Gyblos peer-to-peer AI inference network: sellers online and offline, models and prices, uptime, daily requests and on-chain USDC settlements on Solana.',
  twitter: '@gyblos',
  pagePriority: 0.8,
  // The dark page background, for the browser chrome.
  themeColor: '#090909',
} as const;
