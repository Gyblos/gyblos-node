export const CODE_LANGUAGE = {
  SHELL: 'shell',
  JSON: 'json',
  TOML: 'toml',
  TS: 'ts',
  TEXT: 'text',
} as const;
export type CodeLanguage = (typeof CODE_LANGUAGE)[keyof typeof CODE_LANGUAGE];
export const CODE_TOKEN = {
  COMMENT: 'comment',
  STRING: 'string',
  KEY: 'key',
  NUMBER: 'number',
  LITERAL: 'literal',
  KEYWORD: 'keyword',
  FLAG: 'flag',
  COMMAND: 'command',
  VARIABLE: 'variable',
  SECTION: 'section',
} as const;
export type CodeToken = {
  text: string;
  kind?: (typeof CODE_TOKEN)[keyof typeof CODE_TOKEN];
};
type Rule = [RegExp, CodeToken['kind']];

const STRING = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`;
const RULES: Record<CodeLanguage, Rule[]> = {
  text: [],
  shell: [
    [/#[^\n]*/y, CODE_TOKEN.COMMENT],
    [new RegExp(STRING, 'y'), CODE_TOKEN.STRING],
    [/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/y, CODE_TOKEN.VARIABLE],
    [/(?<=^|\s)--?[A-Za-z][\w-]*/my, CODE_TOKEN.FLAG],
    [/(?<=^|[|;&]\s*)(?:[A-Za-z_][\w./-]*)(?=\s|$)/my, CODE_TOKEN.COMMAND],
  ],
  json: [
    [/"(?:[^"\\\n]|\\.)*"(?=\s*:)/y, CODE_TOKEN.KEY],
    [/"(?:[^"\\\n]|\\.)*"/y, CODE_TOKEN.STRING],
    [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, CODE_TOKEN.NUMBER],
    [/\b(?:true|false|null)\b/y, CODE_TOKEN.LITERAL],
  ],
  toml: [
    [/#[^\n]*/y, CODE_TOKEN.COMMENT],
    [/(?<=^\s*)\[[^\]\n]+\]+/my, CODE_TOKEN.SECTION],
    [/(?<=^\s*)[A-Za-z0-9_.-]+(?=\s*=)/my, CODE_TOKEN.KEY],
    [new RegExp(STRING, 'y'), CODE_TOKEN.STRING],
    [/\b(?:true|false)\b/y, CODE_TOKEN.LITERAL],
    [/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/y, CODE_TOKEN.NUMBER],
  ],
  ts: [
    [/\/\/[^\n]*|\/\*[\s\S]*?\*\//y, CODE_TOKEN.COMMENT],
    [new RegExp(STRING + '|`(?:[^`\\\\]|\\\\.)*`', 'y'), CODE_TOKEN.STRING],
    [
      /\b(?:const|let|var|new|await|async|function|return|import|from|export|type|if|else|for|of|in)\b/y,
      CODE_TOKEN.KEYWORD,
    ],
    [/\b(?:true|false|null|undefined)\b/y, CODE_TOKEN.LITERAL],
    [/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/y, CODE_TOKEN.NUMBER],
    [/[A-Za-z_$][\w$]*(?=\s*:)/y, CODE_TOKEN.KEY],
  ],
};

export function highlightCode(code: string, language: CodeLanguage) {
  const rules = RULES[language];
  const tokens: CodeToken[] = [];
  let plain = '';
  let index = 0;
  while (index < code.length) {
    let matched: CodeToken | undefined;
    for (const [pattern, kind] of rules) {
      pattern.lastIndex = index;
      const found = pattern.exec(code);
      if (found?.[0]) {
        matched = { text: found[0], kind };
        break;
      }
    }
    if (!matched) {
      const word = /[A-Za-z0-9_$]+|[\s\S]/y;
      word.lastIndex = index;
      const text = word.exec(code)?.[0] ?? code[index] ?? '';
      plain += text;
      index += text.length;
      continue;
    }
    if (plain) tokens.push({ text: plain });
    plain = '';
    tokens.push(matched);
    index += matched.text.length;
  }
  if (plain) tokens.push({ text: plain });
  return tokens;
}

export function codeLanguageLabel(language: CodeLanguage) {
  if (language === CODE_LANGUAGE.TS) return 'TypeScript';
  if (language === CODE_LANGUAGE.TEXT) return 'Text';
  return language.toUpperCase();
}

const FENCE_LANGUAGE: Record<string, CodeLanguage> = {
  sh: CODE_LANGUAGE.SHELL,
  bash: CODE_LANGUAGE.SHELL,
  zsh: CODE_LANGUAGE.SHELL,
  shell: CODE_LANGUAGE.SHELL,
  console: CODE_LANGUAGE.SHELL,
  json: CODE_LANGUAGE.JSON,
  toml: CODE_LANGUAGE.TOML,
  ts: CODE_LANGUAGE.TS,
  tsx: CODE_LANGUAGE.TS,
  typescript: CODE_LANGUAGE.TS,
  js: CODE_LANGUAGE.TS,
  javascript: CODE_LANGUAGE.TS,
};

export function fenceLanguage(fence: string): CodeLanguage {
  const name = /^```\s*([\w-]*)/.exec(fence)?.[1]?.toLowerCase() ?? '';
  return Object.prototype.hasOwnProperty.call(FENCE_LANGUAGE, name)
    ? (FENCE_LANGUAGE[name] ?? CODE_LANGUAGE.TEXT)
    : CODE_LANGUAGE.TEXT;
}
