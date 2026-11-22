export const PROFILE_CLAIM = {
  schemaVersion: 1,
  domain: 'gyblos/profile-claim/v1\n',
  minNameCharacters: 1,
  maxNameCharacters: 32,
  maxInputCharacters: 256,
  maxMarksInRow: 3,
  normalization: 'NFKC',
  skeletonNormalization: 'NFD',
  reservedWords: ['gyblos', 'verified', 'verificado', 'official', 'oficial'],
  forbidden:
    /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u,
  forbiddenMarks: /[\p{Me}̴-̸⃐-⃿]/u,
  spaces: /\p{Zs}+/gu,
  allowed: /^[\p{L}\p{Mn}\p{Mc}\p{N} _.'-]+$/u,
  letterOrNumber: /[\p{L}\p{N}]/u,
  letterOrMark: /[\p{L}\p{M}]/u,
  modifierLetter: /(?![々ー])\p{Lm}/u,
  lookalikeLetter: /[ɢɪɴɶʀʁʏʙʛʜʟᴀ-ᴢꜰꜱꞮꞯⱱⱴ]/u,
  strayMark: /(?:^|[^\p{L}\p{M}])\p{M}/u,
  marks: /\p{M}/gu,
  separators: /[ _.'-]/g,
  skeletonLetters: { '0': 'o', '1': 'l', '5': 's', i: 'l', ı: 'l', ǀ: 'l' },
  skeletonPattern: /[015iıǀ]/g,
  sharedScripts: ['Common', 'Inherited'],
  scriptGroups: [
    ['Han', 'Hiragana', 'Katakana'],
    ['Han', 'Hangul'],
    ['Han', 'Bopomofo'],
  ],
} as const;

export const SELLER_NAME_SCRIPTS =
  `Adlam Ahom Anatolian_Hieroglyphs Arabic Armenian Avestan Balinese Bamum Bassa_Vah Batak Bengali Bhaiksuki Bopomofo Brahmi Braille Buginese Buhid Canadian_Aboriginal Carian Caucasian_Albanian Chakma Cham Cherokee Chorasmian Common Coptic Cuneiform Cypriot Cypro_Minoan Cyrillic Deseret Devanagari Dives_Akuru Dogra Duployan Egyptian_Hieroglyphs Elbasan Elymaic Ethiopic Garay Georgian Glagolitic Gothic Grantha Greek Gujarati Gunjala_Gondi Gurmukhi Gurung_Khema Han Hangul Hanifi_Rohingya Hanunoo Hatran Hebrew Hiragana Imperial_Aramaic Inherited Inscriptional_Pahlavi Inscriptional_Parthian Javanese Kaithi Kannada Katakana Kawi Kayah_Li Kharoshthi Khitan_Small_Script Khmer Khojki Khudawadi Kirat_Rai Lao Latin Lepcha Limbu Linear_A Linear_B Lisu Lycian Lydian Mahajani Makasar Malayalam Mandaic Manichaean Marchen Masaram_Gondi Medefaidrin Meetei_Mayek Mende_Kikakui Meroitic_Cursive Meroitic_Hieroglyphs Miao Modi Mongolian Mro Multani Myanmar Nabataean Nag_Mundari Nandinagari New_Tai_Lue Newa Nko Nushu Nyiakeng_Puachue_Hmong Ogham Ol_Chiki Ol_Onal Old_Hungarian Old_Italic Old_North_Arabian Old_Permic Old_Persian Old_Sogdian Old_South_Arabian Old_Turkic Old_Uyghur Oriya Osage Osmanya Pahawh_Hmong Palmyrene Pau_Cin_Hau Phags_Pa Phoenician Psalter_Pahlavi Rejang Runic Samaritan Saurashtra Sharada Shavian Siddham SignWriting Sinhala Sogdian Sora_Sompeng Soyombo Sundanese Sunuwar Syloti_Nagri Syriac Tagalog Tagbanwa Tai_Le Tai_Tham Tai_Viet Takri Tamil Tangsa Tangut Telugu Thaana Thai Tibetan Tifinagh Tirhuta Todhri Toto Tulu_Tigalari Ugaritic Vai Vithkuqi Wancho Warang_Citi Yezidi Yi Zanabazar_Square`.split(
    ' ',
  );

export const SELLER_NAME_ISSUES = {
  LENGTH: 'length',
  CHARACTERS: 'characters',
  MARKS: 'marks',
  SCRIPTS: 'scripts',
  RESERVED: 'reserved',
} as const;
export type SellerNameIssue =
  (typeof SELLER_NAME_ISSUES)[keyof typeof SELLER_NAME_ISSUES];
