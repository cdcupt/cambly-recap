// src/coach.js — Cambly coach-text shaping + the recap's coaching vocabularies.
//
// Two things live here so that build.js (WeekVM composition) and summarize.js (the
// LLM bundle) can share them without a circular import:
//
//   1. Worksheet stripping. Cambly's ai_tutor fields (finalAIFeedback.*, tutorNotes)
//      sometimes carry a pasted vocabulary worksheet / drill after — or instead of —
//      the real coaching sentences. `stripWorksheet` keeps the prose before the first
//      worksheet marker; `stripWorksheetStrict` additionally nulls a value whose FIRST
//      content line is any worksheet boundary (a pasted worksheet is not coaching).
//
//   2. The closed vocabularies the wire schema, the builder and the validator agree
//      on: CEFR bands (7, indexable), the five spoken-language dimensions in their
//      canonical order, the confidence levels and the plan's day labels.

// ── Vocabularies (single source of truth for schema · builder · validator · renderer) ──

/** CEFR bands the level estimate may use, ascending. Index = bandIndex (0..6). */
export const BANDS = Object.freeze(["A2", "A2+", "B1", "B1+", "B2", "B2+", "C1"]);

/** The five CEFR qualitative aspects of spoken language, canonical order. */
export const LEVEL_DIMENSIONS = Object.freeze(["range", "accuracy", "fluency", "interaction", "coherence"]);

/** How sure the estimate is — low when < 3 classes or mostly read-aloud. */
export const CONFIDENCE_LEVELS = Object.freeze(["low", "medium", "high"]);

/** Plan day labels: the seven weekdays plus "Daily". */
export const PLAN_DAYS = Object.freeze(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Daily"]);

/** Exactly how many advice items the level estimate carries at most. */
export const LEVEL_ADVICE_MAX = 3;

/**
 * bandIndex for a band label, or -1 when the label is not a known band.
 * @param {unknown} band
 * @returns {number}
 */
export function bandIndexOf(band) {
  return typeof band === "string" ? BANDS.indexOf(band) : -1;
}

// ── Worksheet detection ─────────────────────────────────────────────────────────
// These fire ONLY on lines that are STRUCTURALLY drill material, never on ordinary
// coaching prose (beta findings 1 + 2). A leading decorative emoji is stripped before
// matching so a celebratory opener ("🎉 Amazing progress this week! …") is judged on
// its words, and the drill keywords are anchored to line-start so "exercise"/"choose
// the correct" never fire as mid-sentence words ("you did this breathing exercise 3
// times").
const LEADING_EMOJI = /^(?:\p{Extended_Pictographic}[\uFE0F\u200D]*)+\s*/u;
const SECTION_TITLE_MAX = 56;

// HARD drill markers — unambiguous worksheet content; always a boundary (tested post
// emoji-strip so an emoji-led "✏️ Exercise 1: …" still matches the line-start anchor).
const DRILL_MARKER = [
  /^exercise\s*\d/i, // "Exercise 1: Choose the Correct Verb"
  /^choose the correct\b/i, // multiple-choice drill instruction
  /^fix the .{0,24}\bmistakes\b/i, // "Fix the … Mistakes" header
  /_{4,}/, // a fill-in-the-blank run  ______  /  → ______
  /^\d+[.)]\s+[^\n]*\([^)]*\/[^)]*\)/, // "1. Yesterday I (go / went / gone) home." drill item
];

/** True iff a line is an emoji-led section title (short, no sentence-ending punctuation). */
function isEmojiSectionTitle(t) {
  if (!LEADING_EMOJI.test(t)) return false;
  const bare = t.replace(LEADING_EMOJI, "").trim();
  if (!bare || bare.length > SECTION_TITLE_MAX) return false;
  return !/[.!?…]$/u.test(bare); // a real coaching sentence ends in . ! ? …
}

/**
 * Classify one line: "hard" (drill marker), "soft" (emoji section title), or "none"
 * for a coaching line.
 * @param {string} rawLine
 * @returns {"hard"|"soft"|"none"}
 */
export function worksheetBoundary(rawLine) {
  const t = rawLine.trim();
  if (!t) return "none";
  const bare = t.replace(LEADING_EMOJI, "").trim() || t;
  if (DRILL_MARKER.some((re) => re.test(bare))) return "hard";
  if (isEmojiSectionTitle(t)) return "soft";
  return "none";
}

/** Index + kind of the first worksheet-boundary line, or {cut:-1} when there is none. */
function firstBoundary(lines) {
  for (let i = 0; i < lines.length; i++) {
    const kind = worksheetBoundary(lines[i]);
    if (kind !== "none") return { cut: i, kind };
  }
  return { cut: -1, kind: "none" };
}

/**
 * Curated coaching prose ONLY — the worksheet/exercise tail Cambly sometimes pastes into
 * an ai_tutor field (finalAIFeedback.whatYouDidWell / tutorNotes) is truncated so the
 * "Focus & tutor feedback" box never shows drill material (beta finding 1). Cuts at the
 * FIRST worksheet-marker line — an emoji-led section title, a line-start "Exercise N" /
 * "Choose the Correct" / "Fix the … Mistakes" header, a run of blank-fill underscores, or a
 * numbered drill item that carries slash options — keeping every genuine coaching sentence
 * before it. A bare celebratory emoji or a plain enumerated coaching tip ("1. Watch your
 * articles.") is NOT a boundary. A non-string passes through untouched; a value that is
 * entirely HARD-marker worksheet collapses to null, but a leading emoji title never nulls
 * the coaching (finding 1) — it is far more likely a decorative opener than a real drill.
 * @param {unknown} text
 * @returns {unknown} the trimmed prose, null, or the non-string input untouched
 */
export function stripWorksheet(text) {
  if (typeof text !== "string") return text;
  const lines = text.split("\n");
  const { cut, kind } = firstBoundary(lines);
  if (cut === -1) return text; // no worksheet tail — unchanged
  const kept = lines.slice(0, cut).join("\n").replace(/\s+$/u, "");
  if (kept !== "") return kept;
  // Nothing kept: a HARD drill marker as the first content line ⇒ all worksheet ⇒ null; a
  // leading emoji title never erases genuine coaching (finding 1) ⇒ keep the text as-is.
  return kind === "hard" ? null : text;
}

/**
 * The STRICT variant for fields that are sometimes a whole pasted worksheet rather than
 * coaching (`whatWeCanWorkOn`, `ideasForPractice`): identical to `stripWorksheet`, except
 * that a value whose FIRST content line is a worksheet boundary — hard OR soft (e.g. the
 * emoji title "💻☕ Tech & Daily Work Small Talk") — becomes null. Coaching prose that
 * precedes a worksheet is still kept.
 * @param {unknown} text
 * @returns {unknown} the trimmed prose, null, or the non-string input untouched
 */
export function stripWorksheetStrict(text) {
  if (typeof text !== "string") return text;
  const lines = text.split("\n");
  const { cut } = firstBoundary(lines);
  if (cut === -1) return text;
  const kept = lines.slice(0, cut).join("\n").replace(/\s+$/u, "");
  return kept === "" ? null : kept;
}

// ── The four coach fields, shaped once for the bundle and the VM ─────────────────

/** A non-blank string, else null. */
function strOrNull(v) {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * The Cambly coach's four prose fields from a normalized lesson's `aiTutorFeedback`,
 * worksheet-stripped with the rule each field needs: `didWell` (lenient strip — a leading
 * emoji never erases praise), `workOn` and `practiceIdeas` (STRICT — a pasted worksheet is
 * not coaching), `nextLesson` verbatim. A plain-string `finalAIFeedback` (older shape) is
 * treated as `didWell`. Every field is a string or null; a null/absent block gives four
 * nulls. Pure.
 * @param {object|null|undefined} aiTutorFeedback
 * @returns {{didWell:string|null, workOn:string|null, practiceIdeas:string|null, nextLesson:string|null}}
 */
export function coachNotes(aiTutorFeedback) {
  const f = aiTutorFeedback && typeof aiTutorFeedback === "object" ? aiTutorFeedback : {};
  const fb = f.finalAIFeedback;
  const obj = fb && typeof fb === "object" ? fb : {};
  const didWellRaw = typeof fb === "string" ? fb : obj.whatYouDidWell;
  return {
    didWell: strOrNull(stripWorksheet(strOrNull(didWellRaw))),
    workOn: strOrNull(stripWorksheetStrict(strOrNull(obj.whatWeCanWorkOn))),
    practiceIdeas: strOrNull(stripWorksheetStrict(strOrNull(obj.ideasForPractice))),
    nextLesson: strOrNull(f.finalSuggestedNextLesson),
  };
}
