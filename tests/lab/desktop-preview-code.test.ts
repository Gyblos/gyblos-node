import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const views = new URL(
  '../../lab/tools/desktop-preview/views/',
  import.meta.url,
);
const transformed = async (file: string) => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  return (
    transformBrand(await readFile(file, 'utf8'), file, 'apps/desktop') ?? ''
  );
};

void test('preview code highlighting tokenizes shell, json, toml and ts without losing text', async () => {
  const { highlightCode } =
    await import('../../lab/tools/desktop-preview/code-highlight');
  const samples = {
    shell:
      '# run it\ncurl \'http://127.0.0.1:8000/v1\' \\\n  --header "Authorization: Bearer $GYBLOS_API_KEY"',
    json: '{\n  "model": "qwen3-0.6b",\n  "stream": false,\n  "max": 12\n}',
    toml: '# config.toml\n[model_providers.gyblos]\nname = "Gyblos"\nretries = 0',
    ts: "const client = new OpenAI({ baseURL: 'http://x' }); // ok",
  } as const;
  for (const [language, code] of Object.entries(samples)) {
    const tokens = highlightCode(code, language as keyof typeof samples);
    assert.equal(tokens.map((token) => token.text).join(''), code, language);
  }
  const kinds = (language: keyof typeof samples) =>
    new Set(
      highlightCode(samples[language], language)
        .filter((token) => token.kind)
        .map((token) => token.kind + ':' + token.text.trim()),
    );
  const shell = kinds('shell');
  assert.ok(shell.has('comment:# run it'));
  assert.ok(shell.has('command:curl'));
  assert.ok(shell.has('flag:--header'));
  assert.ok(shell.has("string:'http://127.0.0.1:8000/v1'"));
  const json = kinds('json');
  assert.ok(json.has('key:"model"'));
  assert.ok(json.has('string:"qwen3-0.6b"'));
  assert.ok(json.has('literal:false'));
  assert.ok(json.has('number:12'));
  const toml = kinds('toml');
  assert.ok(toml.has('section:[model_providers.gyblos]'));
  assert.ok(toml.has('key:name'));
  assert.ok(toml.has('number:0'));
  const ts = kinds('ts');
  assert.ok(ts.has('keyword:const'));
  assert.ok(ts.has('keyword:new'));
  assert.ok(ts.has('comment:// ok'));
});

void test('one preview code block shows the language, colors tokens and copies', async () => {
  const kit = await readFile(new URL('PreviewKit.tsx.preview', views), 'utf8');
  assert.match(kit, /export function CodeBlock\(/);
  assert.match(kit, /className="pk-code-language"/);
  assert.match(kit, /label=\{copied \? 'Copied' : 'Copy ' \+/);
  assert.match(kit, /data-token=\{token\.kind\}/);
  const css = await readFile('lab/tools/desktop-preview/preview.css', 'utf8');
  for (const kind of ['comment', 'string', 'key', 'number', 'keyword', 'flag'])
    assert.match(css, new RegExp(`\\[data-token='${kind}'\\]`));
});

void test('every mockup code sample uses the shared code block', async () => {
  const generic = await transformed('apps/desktop/src/ui/PaypalAgentSetup.tsx');
  assert.match(generic, /<CodeBlock\s+language="shell"/);
  assert.doesNotMatch(generic, /<pre className="ui-code-block">/);
  assert.doesNotMatch(generic, /Copy example request/);
  const message = await transformed('apps/desktop/src/ui/MessageText.tsx');
  assert.match(message, /<CodeBlock/);
  assert.doesNotMatch(message, /<pre key=\{index\}>/);
  const agent = await transformed('apps/desktop/src/ui/BuyerAgentSetup.tsx');
  assert.match(agent, /<CodeBlock/);
  const keys = await readFile(
    new URL('UsdcApiKeys.tsx.preview', views),
    'utf8',
  );
  assert.match(keys, /<CodeBlock/);
  assert.doesNotMatch(keys, /<pre className="ui-code-block">/);
});

void test('detail dialogs share one summary component with room between rows', async () => {
  const kit = await readFile(new URL('PreviewKit.tsx.preview', views), 'utf8');
  assert.match(kit, /export function DetailSummary\(/);
  for (const file of ['ActivitySessionDetails', 'UsdcApiKeys']) {
    const view = await readFile(new URL(`${file}.tsx.preview`, views), 'utf8');
    assert.match(view, /<DetailSummary/, file);
    assert.doesNotMatch(view, /className="preview-detail-totals"/, file);
  }
  const css = await readFile('lab/tools/desktop-preview/preview.css', 'utf8');
  assert.match(css, /\.modal\[data-size\] > \* \{\s*flex-shrink: 0;/);
  assert.match(
    css,
    /grid-template-columns: repeat\(auto-fit, minmax\(96px, 1fr\)\);/,
  );
  const connection = await transformed(
    'apps/desktop/src/ui/PaypalAgentConnection.tsx',
  );
  assert.match(
    connection,
    /<Tag tone=\{TONE\.SUCCESS\} dot>Connection ready<\/Tag>/,
  );
});

void test('code block copy reports success only when the copy action confirms it', async () => {
  const { transformBrand } =
    await import('../../lab/tools/desktop-preview/brand-build');
  const kit = await readFile(
    'lab/tools/desktop-preview/views/PreviewKit.tsx.preview',
    'utf8',
  );
  assert.match(kit, /setCopied\(onCopy \? result === true : true\)/);
  const hookFile = 'apps/desktop/src/ui/paypal-agent-connection-hook.ts';
  const hook =
    transformBrand(
      await readFile(hookFile, 'utf8'),
      hookFile,
      'apps/desktop',
    ) ?? '';
  assert.match(hook, /if \(!connection\) return false;/);
  assert.match(hook, /return copied === true;/);
});

void test('code token kinds and coding-tool languages use canonical closed values', async () => {
  const highlight = await readFile(
    'lab/tools/desktop-preview/code-highlight.ts',
    'utf8',
  );
  assert.match(highlight, /export const CODE_TOKEN = \{/);
  assert.match(
    highlight,
    /kind\?: \(typeof CODE_TOKEN\)\[keyof typeof CODE_TOKEN\]/,
  );
  assert.doesNotMatch(
    highlight,
    /, '(comment|string|key|number|literal|keyword|flag|command|variable|section)'\]/,
  );
  const kit = await readFile(
    'lab/tools/desktop-preview/views/PreviewKit.tsx.preview',
    'utf8',
  );
  assert.match(kit, /export function agentCodeLanguage\(tool: AgentTool\)/);
  assert.match(kit, /tool === AGENT_TOOLS\.CODEX/);
  assert.match(kit, /tool === AGENT_TOOLS\.CLAUDE_CODE/);
});

void test('preview PayPal setup keeps the shipped spending warnings for every connection type', async () => {
  const setup = await transformed('apps/desktop/src/ui/PaypalAgentSetup.tsx');
  assert.match(setup, /Set GYBLOS_API_KEY privately in your terminal/);
  assert.match(
    setup,
    /<p className="ui-help-text">\s*Each completed inference counts toward the shared limit, even if\s*delivery fails\. One instruction can need several inferences\.\s*<\/p>/,
  );
  assert.doesNotMatch(setup, /preset !== CONNECTION_PRESET\.GENERIC && \(/);
});

void test('preview tool guide takes configuration file names from AGENT_SETUP', async () => {
  const source = await readFile(
    new URL('UsdcApiKeys.tsx.preview', views),
    'utf8',
  );
  for (const file of ['opencode.json', 'config.toml', 'models.json'])
    assert.doesNotMatch(
      source,
      new RegExp(`'${file.replace('.', '\\.')}'`),
      file,
    );
  assert.match(source, /AGENT_SETUP\.files\.opencode/);
});
