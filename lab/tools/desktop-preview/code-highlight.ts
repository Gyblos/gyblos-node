// Minimal, dependency-free syntax coloring for the mockup's code samples. Output always
// concatenates back to the input; unknown text keeps no token kind.
export const CODE_LANGUAGE = {
  SHELL: 'shell',
  JSON: 'json',
  TOML: 'toml',
  TS: 'ts',
  TEXT: 'text',
} as const;
export type CodeLanguage = (typeof CODE_LANGUAGE)[keyof typeof CODE_LANGUAGE];
export type CodeToken = {
  text: string;
  kind?:
    | 'comment'
    | 'string'
    | 'key'
    | 'number'
    | 'literal'
    | 'keyword'
    | 'flag'
    | 'command'
    | 'variable'
    | 'section';
};
type Rule = [RegExp, CodeToken['kind']];

const STRING = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`;
const RULES: Record<CodeLanguage, Rule[]> = {
  text: [],
  shell: [
    [/#[^\n]*/y, 'comment'],
    [new RegExp(STRING, 'y'), 'string'],
    [/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/y, 'variable'],
    [/(?<=^|\s)--?[A-Za-z][\w-]*/my, 'flag'],
    [/(?<=^|[|;&]\s*)(?:[A-Za-z_][\w./-]*)(?=\s|$)/my, 'command'],
  ],
  json: [
    [/"(?:[^"\\\n]|\\.)*"(?=\s*:)/y, 'key'],
    [/"(?:[^"\\\n]|\\.)*"/y, 'string'],
    [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, 'number'],
    [/\b(?:true|false|null)\b/y, 'literal'],
  ],
  toml: [
    [/#[^\n]*/y, 'comment'],
    [/(?<=^\s*)\[[^\]\n]+\]+/my, 'section'],
    [/(?<=^\s*)[A-Za-z0-9_.-]+(?=\s*=)/my, 'key'],
    [new RegExp(STRING, 'y'), 'string'],
    [/\b(?:true|false)\b/y, 'literal'],
    [/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/y, 'number'],
  ],
  ts: [
    [/\/\/[^\n]*|\/\*[\s\S]*?\*\//y, 'comment'],
    [new RegExp(STRING + '|`(?:[^`\\\\]|\\\\.)*`', 'y'), 'string'],
    [
      /\b(?:const|let|var|new|await|async|function|return|import|from|export|type|if|else|for|of|in)\b/y,
      'keyword',
    ],
    [/\b(?:true|false|null|undefined)\b/y, 'literal'],
    [/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/y, 'number'],
    [/[A-Za-z_$][\w$]*(?=\s*:)/y, 'key'],
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
