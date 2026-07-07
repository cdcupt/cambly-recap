// src/render/text.js — display-only text shaping for the renderer.
//
// These transforms touch DISPLAY ONLY — the stored VM / archived data is never
// mutated. They run on plain text in the component layer BEFORE esc(), so the
// output still flows through the standard escape path (no raw markup produced).

const TOPIC_MAX = 60;
const ELLIPSIS = "…"; // …

/** A screaming ALL-CAPS phrase: has letters, no lowercase, and ≥3 words (a pasted
 * greeting like "HELLO EVERYONE NICE TO MEET YOU" — but never a short title
 * or a lone acronym such as "TOEFL"). */
function isScreaming(s) {
  if (!/[A-Z]/.test(s)) return false;
  if (/[a-z]/.test(s)) return false;
  return s.trim().split(/\s+/).length >= 3;
}

/** Lowercase everything, then capitalize the first letter of each sentence. */
function toSentenceCase(s) {
  const lower = s.toLowerCase();
  let capNext = true;
  let out = "";
  for (const ch of lower) {
    if (capNext && /[a-z]/.test(ch)) {
      out += ch.toUpperCase();
      capNext = false;
    } else {
      out += ch;
      if (/[.!?]/.test(ch)) capNext = true;
    }
  }
  return out;
}

/** Clip to `max` chars, preferring the last word boundary, then append an ellipsis. */
function clip(s, max) {
  const head = s.slice(0, max);
  const lastSpace = head.lastIndexOf(" ");
  const body = lastSpace > max * 0.6 ? head.slice(0, lastSpace) : head;
  return body.replace(/[\s.,;:!?-]+$/, "") + ELLIPSIS;
}

/**
 * Normalize a class "topic" for DISPLAY only. A screaming ALL-CAPS topic is softened
 * to sentence case, and an over-long topic is capped to ~TOPIC_MAX characters with an
 * ellipsis. Returns "" for a null/blank/non-string topic. Pure and non-mutating — the
 * caller still passes the result through esc() before it reaches the page.
 */
export function displayTopic(topic, max = TOPIC_MAX) {
  if (typeof topic !== "string") return "";
  let t = topic.trim();
  if (t === "") return "";
  if (isScreaming(t)) t = toSentenceCase(t);
  if (t.length > max) t = clip(t, max);
  return t;
}
