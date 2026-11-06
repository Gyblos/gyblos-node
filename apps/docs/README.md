# Gyblos Docs

Source of [docs.gyblos.com](https://docs.gyblos.com): guides for running a
Gyblos node, in English and Spanish. Built with [Fumadocs](https://fumadocs.dev)
on Next.js as a static export.

## Commands

From the repository root:

```sh
pnpm install
pnpm docs:dev     # http://localhost:3000/en
pnpm docs:build   # static site in apps/docs/out
pnpm docs:test    # acceptance checks against that static export
```

`pnpm typecheck`, `pnpm lint`, `pnpm test` and CI's `pnpm docs:build` followed
by `pnpm docs:test` cover this app with the rest of the repository. The export
tests check every authored locale page, commands, warning titles, internal links
and anchors, Markdown, full exports and discovery metadata. In `docs:dev`, open
`/en` or `/es`: the root redirect only exists on Cloudflare
(`public/_redirects`).

## Publishing

Cloudflare serves `out/` as static files (`wrangler.jsonc`, with
`public/_headers` and `public/_redirects`). Publishing is a founder-approved
manual step:

```sh
cd apps/docs && pnpm build && npx wrangler@4.151.1 deploy
```

## Writing pages

- Pages live in `content/docs` as MDX. Each page has an English file
  (`page.mdx`) and a Spanish one (`page.es.mdx`) with the same content; update
  both together.
- `meta.json` / `meta.es.json` set the sidebar order and folder titles.
- Commands and messages in a guide must match the node release it describes;
  `tests/docs-content.test.ts` checks the output the seller guide quotes.
- Never put relay tokens, invite codes, keys or private URLs in a page, even as
  examples.
- Public copy and Markdown are generated from compiled MDX, with no separately
  maintained content. New MDX components need a plain Markdown form in
  `components/markdown.tsx`; preserve their titles, links and warnings.

## Plain-text access

- `/llms.txt` indexes all pages by language, linking directly to Markdown.
- `/llms-full.txt` contains every complete article; `/en/llms-full.txt` and
  `/es/llms-full.txt` contain only the selected language.
- `/markdown/en/index.md` is the English home page, and
  `/markdown/es/sellers/beta-guide.md` is the Spanish guide. Every authored page
  gets a stable `/markdown/<locale>/<path>.md` URL, with `index` for home pages.
- Every page exposes **Copy page** and **View Markdown**, plus a Markdown
  alternate link and an `llms.txt` discovery link. Copy failures point readers
  to the direct Markdown link. Compact controls show a copy/check icon, Markdown
  icon and an **Open in** menu with the ChatGPT, Claude, Claude Code and Cursor
  icons. Success is shown inside the copy button and announced to screen
  readers. Controls are 32px tall with 12px labels on desktop, with larger touch
  targets on coarse-pointer devices. Provider icon attribution ships in
  `public/third-party-icons.txt`.
- Assistant links prefill a composer with the canonical public Markdown URL, in
  the page's language; they never include the current browser URL, local preview
  address, query parameters, private content or a local folder. They only open
  after an explicit click and do not submit a prompt. Claude Code uses the
  [official Desktop deep link](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link)
  and needs the app installed. The local preview's assistant links still point
  to the public site, whose content changes only after an approved deployment.
- `sitemap.xml`, `robots.txt` and page metadata use the canonical public URL.

The sidebar uses three grid columns with a fixed desktop navigation width. Keep
the width in `app/global.css` and the container grid in `[lang]/layout.tsx`
aligned with Fumadocs collapse state; outer centering gutters must not enlarge
the sidebar on wide screens. Check desktop, tablet and mobile, both languages,
light/dark themes, search, clipboard feedback and keyboard focus after layout
changes.

## Layout

- `app/[lang]` — the docs layout and pages; every URL carries its locale
  (`/en/…`, `/es/…`).
- `app/api/search` — the search index, built at export time and searched in the
  browser.
- `lib/layout.shared.tsx` — navigation and the Spanish interface strings.
- `app/global.css` — the Gyblos palette.
- `app/global-not-found.tsx` — the 404 page, in both languages.
