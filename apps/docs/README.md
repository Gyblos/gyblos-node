# Gyblos Docs

Source of [docs.gyblos.com](https://docs.gyblos.com): the public guides for
Gyblos buyers and sellers, in English and Spanish. Built with
[Fumadocs](https://fumadocs.dev) on Next.js as a static export.

## Commands

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm docs:dev     # http://localhost:3000/en
pnpm docs:build   # static site in apps/docs/out
pnpm docs:test    # acceptance checks against that static export
```

`pnpm typecheck`, `pnpm lint` and `pnpm test` cover this app with the rest of
the repository, and CI runs `pnpm docs:build` followed by `pnpm docs:test`. The
export tests check every page in both languages: Markdown output, code blocks,
warning titles, internal links and anchors, page actions, the sidebar and
discovery metadata.

In `docs:dev`, open `/en` or `/es` directly. The root redirect exists only in
the deployed site (`public/_redirects`).

## Publishing

Cloudflare serves `out/` as static files (`wrangler.jsonc`, `public/_headers`,
`public/_redirects`). Deploying the site is a maintainer procedure kept outside
the repository, and it needs founder approval.

## Site structure

Pages live in `content/docs` as MDX. `meta.json` and `meta.es.json` in each
folder set the sidebar order and folder titles:

- **Get started**: overview (`index`), how it works, requirements (`beta`) and
  the glossary of canonical terms.
- **Sellers**: Quickstart, register and publish, models, get paid, operate,
  identity, and install without the script.
- **Buyers**: the desktop app and use from code.
- **Reference**: CLI, configuration, and data and privacy.
- **Help**: troubleshooting.

Page slugs are stable: tests and external links depend on them. Change titles,
not slugs. Each top-level folder has an icon ID that
`components/sidebar-icons.tsx` resolves; use the same ID in both locales.

## Writing pages

Structure:

- Every page has an English file (`page.mdx`) and a Spanish one (`page.es.mdx`)
  with the same sections and identical code blocks. Update both together.
  English pages link only to `/en/...`, Spanish pages only to `/es/...`.
- Use the terms defined in the glossary page (`getting-started/glossary`).
  Spanish pages use **tú** and keep commands, keys, error codes, quoted output
  and product names untranslated.
- Each task gives prerequisites, steps, expected output, what to do on failure
  and a next step. Automated parity checks do not prove translation quality.
- Public seller and buyer procedures are canonical here. Engineering docs in
  `docs/` keep checkout, library and experimental detail and link to these
  pages. Do not copy lab or operational history into public pages.
- New MDX components need a plain Markdown form in `components/markdown.tsx`
  that keeps their titles, links and warnings. Markdown and copy text are
  generated from the compiled MDX; nothing is maintained separately.

Tests that pin content (read them before a rewrite):

- `tests/docs-content.test.ts`: every page and `meta` file has both languages;
  links stay in their language; each quoted node message and status value
  (`QUOTED_OUTPUT`, `STATUS_RESULTS`) still appears in the source and in at
  least one page per language. The `compose.yaml` and `config.toml` blocks in
  `sellers/manual-install` must match the heredocs in `install.sh` byte for
  byte, so change their comments only in `install.sh`.
- `tests/docs-seller-handbook.test.ts`: every page in `JOURNEY` is reachable
  from the sidebar with no orphans, has a title, a description and real content.
  Complete `version = 1` TOML examples must parse and resolve to free offers;
  keep priced snippets partial. EN and ES code blocks must be identical and in
  the same order.
- `tests/docs-desktop-guide.test.ts`: wording the desktop app page must keep.
- `apps/docs/test/export.test.ts`: the built sidebar order, the home page
  heading and per-page export checks.

Adding, moving or renaming a page means updating `JOURNEY` and the expected
sidebar in those tests in the same change.

Never publish:

- Relay tokens, invite codes, keys, signed payloads or private URLs, even as
  examples. A test rejects `gyb_` invite codes and relay token assignments.
- Commands or messages that the node release does not print.

## Plain-text access

- `/llms.txt` indexes all pages by language, with direct Markdown links.
  `/llms-full.txt` holds every article; `/en/llms-full.txt` and
  `/es/llms-full.txt` hold one language.
- Every page has a stable `/markdown/<locale>/<path>.md` URL (`index` for home
  pages), a **Copy page** button, a **View Markdown** link and an **Open in**
  menu for ChatGPT, Claude, Claude Code and Cursor. Provider icon attribution
  ships in `public/third-party-icons.txt`.
- Assistant links carry only the canonical public Markdown URL of the page, in
  its language, and open only on an explicit click; `lib/assistant-links.ts`
  owns the rules. Local previews still link to the public site.
- `sitemap.xml`, `robots.txt` and page metadata use the canonical public URL.

After layout changes, check desktop, tablet and mobile widths, both languages,
light and dark themes, search, copy feedback and keyboard focus. The sidebar
width lives in `app/global.css` and the container grid in
`app/[lang]/layout.tsx`.

## Brand assets

The site uses the official Gyblos brand kit **3.0.0**: the solid light and dark
wordmarks (outlined artwork), the terminal-symbol favicon, Instrument Sans
400/500/600 and JetBrains Mono 400/500. Fonts are bundled from `app/brand`, so
no page, including the bilingual 404, requests Google Fonts or downloads fonts
at build time. `public/brand` ships the OFL licenses for Instrument Sans,
JetBrains Mono and Geist Mono (used in the symbol) and the kit attribution.

`gyblos-brand-tokens.css` owns the single brand blue, `#0a28f0`; other styles
reference its variable. Reading and navigation text stay neutral in both themes,
and primary blue actions use white text. Wordmark SVGs keep their supplied
geometry and aspect ratio.

`brand-assets.json` records checksums of the copied kit files. Only the
generated stylesheet is formatted by Prettier, and its original checksum is
recorded too. To adopt a new kit, replace the files and checksums together, keep
the font licenses and run the export tests and visual checks.

## Layout

- `app/[lang]`: the docs layout and pages; every URL carries its locale
  (`/en/…`, `/es/…`).
- `app/api/search`: the search index, built at export time and searched in the
  browser.
- `lib/layout.shared.tsx`: navigation and the Spanish interface strings.
- `app/global.css`: the Gyblos palette and layout widths.
- `app/global-not-found.tsx`: the 404 page, in both languages.
