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
```

`pnpm typecheck`, `pnpm lint`, `pnpm test` and CI's `pnpm docs:build` cover this
app with the rest of the repository. In `docs:dev`, open `/en` or `/es`: the
root redirect only exists on Cloudflare (`public/_redirects`).

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

## Layout

- `app/[lang]` — the docs layout and pages; every URL carries its locale
  (`/en/…`, `/es/…`).
- `app/api/search` — the search index, built at export time and searched in the
  browser.
- `lib/layout.shared.tsx` — navigation and the Spanish interface strings.
- `app/global.css` — the Gyblos palette.
- `app/global-not-found.tsx` — the 404 page, in both languages.
