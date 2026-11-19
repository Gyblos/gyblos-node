# Desktop web preview

Review the seven buyer screens in a browser before changing the desktop app. The
build uses the current desktop renderer and shared components, with synthetic
host adapters in place of Electron, wallets, providers and payment services.

```sh
pnpm install --frozen-lockfile
pnpm desktop:preview:build
python3 -m http.server 5196 --bind 127.0.0.1 --directory lab/tools/desktop-preview/dist
```

Open `http://127.0.0.1:5196/?screen=connections&connection-state=ready`. The
`screen` parameter accepts `chat`, `connections`, `models`, `applications`,
`activity`, `payments` and `settings`. Use `connection-state=unconfigured` for
an unconfigured example. Subsequent navigation uses the normal desktop controls.
Example changes last only until the page reloads. A copied API key is
deliberately invalid. Connection examples can be copied from the setup dialog.

## Brand proposal awaiting desktop approval

The browser build applies the approved brand kit 3.0.0 terminal symbol and the
published website's darker neutrals. `brand.json` records the source revision
and token mapping. Instrument Sans remains the interface face; technical values
keep JetBrains Mono. There is one blue, `#0a28f0`; reading text stays neutral.
Semantic status colors and third-party artwork retain their existing meaning.

The two terminal SVGs are supplied brand-kit artwork with unchanged geometry.
Typography licenses and attribution already live in `apps/docs/public/brand/`.
The brand source is [web-gyblos](https://github.com/Gyblos/web-gyblos):
`web/src/brand.css`, `web/src/components/focus-landing.css` and the versioned
`web/public/brand-assets/` distribution. No private vault content is required to
build this preview.

`brand-build.ts` selects the browser-only implementations under `views/` and
adapts renderer modules while bundling. The shared card is
`views/StatCard.tsx.preview` and the Payments layout is
`views/Payments.tsx.preview`. Their styles are in `preview.css`. The unmodified
desktop renderer is also built as a comparison baseline.

Keep the environment in the title bar. Use “Wallet address” for the public address
and “View transaction in explorer” for transaction links. Omit the fixed
network from wallet facts and other screen labels, including accessible names.

The free-network caption beside Send is omitted in this proposal. The model
name, Free badge and actionable authorization/generation status copy remain
visible.

Follow the root `AGENTS.md` and `apps/desktop/DESIGN.md`: show the mockup,
obtain explicit approval, then port the accepted visual proposal to the desktop
app. Publishing this preview or its PR is not desktop implementation approval.

Open `?screen=payments&review=wallet-backup&backup=needed` to inspect the
recovery warning, or use `backup=verified` to see the green check. Both use
synthetic wallet metadata.

## Validation and limits

Run `node --import tsx --test "tests/lab/desktop-preview*.test.ts"` for the
fixture, brand, isolation and build checks. Run the repository checks before a
PR. Review all seven screens at wide and narrow widths, both themes, keyboard
focus, reduced motion, sidebar/context motion and relevant connection/payment
states.

Generated output stays in ignored `dist/`. `source-manifest.json` records the
Git revision, unchanged renderer baseline assets, proposed preview assets and
brand provenance. `dist/desktop` preserves the unchanged renderer build for
comparison; it has no synthetic host and is not a second review app. Old
generated assets may remain after a rebuild; the manifest hashes only the assets
referenced by HTML.

Tests build into a unique temporary directory and remove only that directory.
The build disables Vite configuration-file discovery and environment-file
loading, and exposes no prefixed environment variables.

No native service is started. The page blocks network connections through its
Content Security Policy. No real configuration folder, credential, prompt,
wallet, transaction, seller or payment is read or used. The example free
response has no transaction hash. Data and metrics are illustrative, not
evidence of a working provider or payment. Browser navigation never validates
native window controls, clipboard permissions or operating-system dialogs.

All seven screens share the preview button standard: filled neutral for ordinary
actions, brand blue for the primary action, and integrated icon controls with a
hover surface and visible keyboard focus. Use a switch for a binary setting and
plain text for selection status. Destructive confirmation uses a separate danger
treatment. Review both themes with `?screen=settings&review=buttons&theme=light`
or `theme=dark`; omit `review=buttons` to inspect the screen.

Every data table in a review screen uses ScrollTable, including short lists. It
owns the accessible scroll region and renders DataTable with the shared header,
separators and spacing. Screens supply the columns, cells and shared pagination.
Pagination controls are 24 px high, with square arrow buttons and content-sized
labels. Keep row-action tooltips short and include the row identity in the
accessible name. Their shared browser implementation adapts the
[shadcn/ui Table](https://ui.shadcn.com/docs/components/table) to the Gyblos
theme. Row actions use named IconButton controls.

Use the shared StatCard inside a StatGrid for summary metrics in the mockup.
Each card shows an icon, label and regular-weight value. Supply the formatted
unit for monetary amounts and the comparison when comparable observations exist.
Equal readings show a neutral 0% pill, including two measured zeroes. A dash
marks an unavailable percentage. Activity compares calendar periods and Payments
compares with the opening preview snapshot. An unavailable measurement is
distinct from a measured zero.
