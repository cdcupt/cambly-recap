// src/render/esc.js — escaping + the only three content→HTML transforms (F4).
//
// XSS stance (§8 F1): transcript content is untrusted external data. Every
// interpolated value is HTML-escaped FIRST; the only tags ever produced from
// content are the three whitelisted micro-markup transforms below, applied AFTER
// escaping. There is no innerHTML-style passthrough anywhere in the renderer.

// The canonical quote-guard normalizer is shared with the builder so the guard and
// this renderer re-assert can never drift (F4 ▣ check). Re-exported here because
// validate.js and the render tests import it from this module.
export { normalizeQuote } from "../quote.js";

const HTML_ENTITIES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** HTML-escape every dynamic value. Non-strings coerce (null/undefined → ""). */
export function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
}

/**
 * practice.prompt: each run of underscores (the ____ gap marker) becomes a
 * <span class="gapline">, keeping the underscores as its visible content. Applied
 * to already-escaped text (underscores survive escaping).
 */
export function gapMarkup(escaped) {
  return escaped.replace(/(_{2,})/g, '<span class="gapline">$1</span>');
}

/**
 * practice.answer: **x** becomes <b>x</b> — the corrected words highlighted in the
 * green answer box. Applied to already-escaped text (asterisks survive escaping).
 */
export function boldMarkup(escaped) {
  return escaped.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
}

/**
 * moment.text: curly-quoted spans “…” become <q>…</q>. Applied to already-escaped
 * text (curly quotes are non-ASCII and survive escaping). Nested straight quotes,
 * if any, are already entities and cannot break out.
 */
export function momentMarkup(escaped) {
  return escaped.replace(/“([^“”]*)”/g, "<q>$1</q>");
}

/** Escape then apply the prompt gap transform, then append the italic cue hint. */
export function renderPrompt(prompt, cue) {
  let out = gapMarkup(esc(prompt));
  if (cue !== null && cue !== undefined && String(cue).trim() !== "") {
    out += ` <em class="cue">(${esc(cue)})</em>`;
  }
  return out;
}

/** Escape then apply the answer bold transform. */
export function renderAnswer(answer) {
  return boldMarkup(esc(answer));
}

/** Escape then apply the moment quote transform. */
export function renderMoment(text) {
  return momentMarkup(esc(text));
}
