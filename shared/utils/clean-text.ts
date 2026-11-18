// S15 (docs/specs/generate.md): model-written text is cleaned before it's
// checked, stored or shown, in three steps:
// 1. Control characters (Unicode Cc: newlines, tabs, bell...) and zero-width
//    spaces (U+200B, often used as a word break) become spaces, so words
//    they separate don't run together.
// 2. Invisible characters are removed: format characters (Cf: text-direction
//    overrides U+202A–U+202E and U+2066–U+2069, BOM, soft hyphen, ZWJ/ZWNJ)
//    and everything else Unicode marks as default-ignorable, which covers
//    invisible characters outside Cf (variation selectors, Hangul fillers,
//    combining grapheme joiner), plus the blank Braille pattern U+2800. They
//    can make text display differently from what it says ("Cor\uFE0Folla"
//    shows as Corolla but doesn't match it). ZWJ/ZWNJ matter in some scripts
//    and emoji; our text is English prose, so they go too.
// 3. Whitespace runs collapse to one space.
export function cleanText(text: string) {
    return text
        .replace(/[\p{Cc}\u200B]/gu, " ")
        .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu, "")
        .replace(/\s+/g, " ")
        .trim();
}
