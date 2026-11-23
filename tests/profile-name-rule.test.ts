import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseSellerName,
  PROFILE_CLAIM,
  SELLER_NAME_ISSUES,
} from '@gyblos/protocol/profile-claim';

const accepted = (input: string) => {
  const result = parseSellerName(input);
  assert.ok(result.ok, `expected ${JSON.stringify(input)} to be accepted`);
  return result.name;
};
const issueOf = (input: unknown) => {
  const result = parseSellerName(input);
  assert.ok(!result.ok, `expected ${JSON.stringify(input)} to be refused`);
  return result.issue;
};

void test('a seller name is NFKC-normalized, trimmed and its inner spaces collapsed', () => {
  assert.equal(accepted('  Ada   Lovelace  '), 'Ada Lovelace');
  assert.equal(accepted('Ada\u00a0Lovelace'), 'Ada Lovelace');
  assert.equal(accepted('Ada\u3000Lovelace'), 'Ada Lovelace');
  assert.equal(accepted('Ｌａｂ\u3000４２'), 'Lab 42');
  assert.equal(accepted('Cafe\u0301'), 'Café');
  assert.equal(accepted('ﬁne'), 'fine');
  assert.equal(accepted('node①'), 'node1');
});

void test('a seller name keeps letters and numbers of any script and the allowed punctuation', () => {
  for (const name of [
    'a',
    '7',
    "O'Brien",
    'node_01',
    'east-1.lab',
    'Zoë Ñúñez',
    '東京ノード',
    'Москва',
    'محمد',
    'שלום',
    'x'.repeat(PROFILE_CLAIM.maxNameCharacters),
    '東'.repeat(PROFILE_CLAIM.maxNameCharacters),
    '𝒜'.repeat(PROFILE_CLAIM.maxNameCharacters),
  ])
    assert.equal(accepted(name), name.normalize('NFKC'));
});

void test('a seller name outside 1 to 32 characters is refused', () => {
  for (const input of [
    '',
    '   ',
    '\u3000',
    'x'.repeat(PROFILE_CLAIM.maxNameCharacters + 1),
    '東'.repeat(PROFILE_CLAIM.maxNameCharacters + 1),
    'x'.repeat(PROFILE_CLAIM.maxInputCharacters + 1),
  ])
    assert.equal(issueOf(input), SELLER_NAME_ISSUES.LENGTH, input);
});

void test('check marks, emoji, symbols, controls and invisible characters are refused', () => {
  for (const input of [
    'Ada ✓',
    'Ada ✔',
    '✅ Ada',
    '☑ Ada',
    '✓',
    'Ada 😀',
    'Ada 👍🏽',
    '🇺🇸 Ada',
    '1\ufe0f\u20e3 Ada',
    'Ada ♥',
    'Ada √',
    'Ada ©',
    'Ada $',
    'Ada @home',
    'Ada/Lab',
    'Ada <b>',
    'Ada\u202eabc',
    'Ada\u202d',
    'Ada\u2066x\u2069',
    'Ada\u200f',
    'Ada\u061c',
    'Ad\u200ba',
    'Ad\u200da',
    'Ad\u00ada',
    'Ad\ufeffa',
    'Ad\u2060a',
    'Ada\ufe0f',
    'Ada\u3164',
    '\u3164',
    'Ada\u115f',
    'Ada\uffa0',
    'Ada\tLab',
    'Ada\nLab',
    'Ada\rLab',
    'Ada\u0000',
    'Ada\u007f',
    'Ada\u0085',
    'Ada\u2028Lab',
    'Ada\u2029Lab',
    'Ada\ue000',
    'Ada\ud800',
    'Ada‘s',
    '-',
    '...',
    "' _ '",
  ])
    assert.equal(
      issueOf(input),
      SELLER_NAME_ISSUES.CHARACTERS,
      JSON.stringify(input),
    );
});

void test('a seller name containing the reserved word is refused in any case or width', () => {
  for (const input of [
    'gyblos',
    'Gyblos',
    'GYBLOS',
    'gYbLoS',
    'Gyblos Official',
    'the gyblos team',
    'mygyblosnode',
    'Ｇｙｂｌｏｓ',
    'gyblos_1',
  ])
    assert.equal(issueOf(input), SELLER_NAME_ISSUES.RESERVED, input);
});

void test('names in many writing systems, with their marks, are accepted', () => {
  for (const name of [
    'Zoë',
    'Nodo Santiago',
    'नमस\u094dत\u0947',
    'স\u09cdব\u09beগতম',
    'வணக\u0bcdகம\u0bcd',
    'สมศ\u0e31กด\u0e34\u0e4c',
    'م\u064fح\u064eم\u064e\u0651د',
    'ש\u05b8\u05c1לו\u05b9ם',
    '한국',
    'ありがとう',
    'ラーメン',
    '東京ノード',
    '佐藤さん',
    '김민수 金',
    'Ṣọ\u0300lá',
    'Ελλάδα',
    'Москва 7',
  ])
    assert.equal(accepted(name), name.normalize('NFKC'), name);
});

void test('marks must follow a letter or a mark, at most three in a row, and never enclose or overlay', () => {
  for (const input of [
    '\u0301Ada',
    'Ada \u0301',
    'Ada1\u0301',
    "Ada'\u0301",
    'Ada-\u0301',
    'x\u0300\u0301\u0302\u0303',
    'Ada\u20dd',
    'Ada\u20e3',
    'Ada\u20d2',
    'Ada\u0334',
    'Ada\u0338',
    'Ada\u0488',
  ])
    assert.equal(
      issueOf(input),
      SELLER_NAME_ISSUES.MARKS,
      JSON.stringify(input),
    );
  assert.equal(accepted('x\u0300\u0301\u0302'), 'x\u0300\u0301\u0302');
});

void test('letters from more than one writing system are refused, except Chinese with kana, Hangul or Bopomofo', () => {
  for (const input of [
    'G\u0443blos',
    'gybl\u03bfs',
    'Ada \u0410da',
    'Ada \u05e9\u05dc\u05d5\u05dd',
    '\ua4d6\ua4ec Ada',
    '\u13a0da',

    '\u3042\ud55c',
    'Ada \u05e9',
  ])
    assert.equal(
      issueOf(input),
      SELLER_NAME_ISSUES.SCRIPTS,
      JSON.stringify(input),
    );
});

void test('modifier letters, small capitals and check-like letters are refused', () => {
  for (const input of [
    'Ada\u02c7',
    'Ada\u02b9',
    '\u0262\u028f\u0299\u029f\u1d0f\ua731',
    'Ada \u0262',
    '\u2c71',
    'Ada \u2c71',
    'Ada \u2c74',
    'Ada \u1d00',
  ])
    assert.equal(
      issueOf(input),
      SELLER_NAME_ISSUES.CHARACTERS,
      JSON.stringify(input),
    );
});

void test('reserved words are refused on a skeleton that ignores case, separators and look-alike digits', () => {
  for (const input of [
    'GYBL0S',
    'g.yblos',
    'gyb los',
    'gy-blos',
    "g'yblos",
    'gyb_los',
    'GYBL05',
    'gybıos',
    'gybǀos',
    'Ver1fied',
    'verified seller',
    'VERIFIED',
    'Verificado',
    'Official',
    'oficial',
    '0fficial',
    'Gybìos',
  ])
    assert.equal(issueOf(input), SELLER_NAME_ISSUES.RESERVED, input);
});

void test('a seller name that is not a string is refused', () => {
  for (const input of [null, undefined, 42, ['Ada'], { name: 'Ada' }])
    assert.equal(issueOf(input), SELLER_NAME_ISSUES.CHARACTERS);
});

void test('only recommended scripts are accepted, so Lisu, Cherokee and Coptic look-alikes are refused', () => {
  for (const input of [
    '\ua4d6\ua4ec\ua4d0\ua4e1\ua4f3\ua4e2',
    '\ua4e6\ua4f0\ua4e3\ua4f2\ua4dd\ua4f2\ua4f0\ua4d3',
    '\ua4f3\ua4dd\ua4dd\ua4f2\ua4da\ua4f2\ua4ee\ua4e1',
    '\ua4d6\ua4ec\ua4d0\ua4e1\ua4f3\ua4e2 \ua4e0\ua4f3\ua4d3\ua4f0',
    '\u13c0\u13bd\u13f4\u13de\u13be\u13da',
    '\u13d9\u13ac\u13a1',
    '\u2c84\u2ca9\u2c83\u2c97\u2c9f\u2ca5',
    'Gybl\u0ae6s',
    'gybl\u09e6s',
    'Gybl\u0d66s',
    'Ada \u0661\u0662 12',
    'Ada \u0966',
  ])
    assert.equal(
      issueOf(input),
      SELLER_NAME_ISSUES.SCRIPTS,
      JSON.stringify(input),
    );
  assert.notEqual(parseSellerName('gybl\u07c0s').ok, true);
});

void test('Latin look-alike letters and digits are read as their base letter for reserved words', () => {
  for (const input of [
    '\u0261yblos',
    'offici\u0251l',
    'gyb\u0142os',
    'gybl\u00f8s',
    '\u028berified',
    'veri\u0192ied',
    '\u00f8fficial',
    'Gybl\u3007s',
    'Gyb\u0269os',
    '\ua7acyblos',
    'gy\ua7b5los',
    'GYB\u0141OS',
    'gy\u0180los',
    'ver\u0268fied',
  ])
    assert.equal(
      issueOf(input),
      SELLER_NAME_ISSUES.RESERVED,
      JSON.stringify(input),
    );
});

void test('typographic apostrophes become straight, and Latin may join Han with kana, Hangul or Bopomofo', () => {
  const cases: [string, string][] = [
    ['O\u2019Brien', "O'Brien"],
    ['O\u02bcBrien', "O'Brien"],
    ['Hawai\u02bbi', "Hawai'i"],
    ['O\u02bbzbek', "O'zbek"],
    ['AI \u30e9\u30dc', 'AI \u30e9\u30dc'],
    ['GPU \u5de5\u4f5c\u5ba4', 'GPU \u5de5\u4f5c\u5ba4'],
    ['K-pop \uc2a4\ud0c0', 'K-pop \uc2a4\ud0c0'],
    ['Tokyo \u6771\u4eac', 'Tokyo \u6771\u4eac'],
    ['\u91d1\u5b50\u307f\u3059\u309e', '\u91d1\u5b50\u307f\u3059\u309e'],
  ];
  for (const [input, name] of cases) assert.equal(accepted(input), name, input);
});

void test('marks are counted on the decomposed text and decorative marks are refused', () => {
  for (const input of [
    'a\u0301\u0301\u0301\u0301',
    '\u00e1\u0301\u0301\u0301',
    'A\u0332d\u0332a\u0332',
    'Ada\u0359\u035c\u0361x',
    'Ada\u1ab0\u1ab1\u1ab2',
    'Ada\ufe20\ufe21',
    'Ada\u0305',
    'Ada\u0333',
    'Ada\u033f',
  ])
    assert.equal(
      issueOf(input),
      SELLER_NAME_ISSUES.MARKS,
      JSON.stringify(input),
    );
});
