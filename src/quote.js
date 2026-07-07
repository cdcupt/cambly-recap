// src/quote.js — the single canonical quote-guard normalizer (TECH §10).
//
// One implementation, shared by the builder's quote-guard (src/build.js) and the
// renderer's defensive re-assert (src/render/esc.js), so the two can never drift
// (the earlier duplication folded backtick/acute in the builder but not the
// renderer — a latent divergence between the guard and the re-assert). Contract:
// Unicode NFKC, curly→straight quotes and apostrophes, whitespace runs collapsed
// to one space. CASE IS PRESERVED — a case mismatch is a real mismatch (U-QG ⑤).

const SINGLE_QUOTES = /[‘’‚‛′`´]/g; // ‘ ’ ‚ ‛ ′ ` ´
const DOUBLE_QUOTES = /[“”„‟″]/g; //           “ ” „ ‟ ″

/**
 * Normalize a quote or corpus line for comparison. Order: Unicode NFKC, then
 * curly→straight quotes/apostrophes, then whitespace runs collapsed to one space.
 * @param {unknown} s
 * @returns {string} "" for a non-string input.
 */
export function normalizeQuote(s) {
  if (typeof s !== "string") return "";
  return s
    .normalize("NFKC")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(/\s+/g, " ")
    .trim();
}
