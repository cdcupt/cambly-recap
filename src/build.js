// src/build.js — builder (TECH §3 "builder", §10 canonical WeekVM contract).
//
// The builder owns BOTH integrity gates and composes the canonical WeekVM from
// (a) the normalized lessons and (b) the LLM's narrow wire output. It writes no
// HTML — rendering is the frontend renderer's job (§F1). Enforcement points:
//
//   Gate #1 quote-guard  — every ▣ field (vocabulary.quote, phrasing.said, each
//     classes[].moment.quotes entry) must substring-match the lesson's quote corpus
//     after NFKC + curly→straight + whitespace-collapse (case-preserving), on the
//     side matching quoteBy. Fail ⇒ dropped + logged, never rendered. Practice items
//     carry no verbatim field and are gated by lineage instead.
//
//   Gate #2 Σ-invariant  — the multiset of placed correction ids (grammar items ∪
//     non-null vocabulary.fromCorrectionId ∪ non-null phrasing.fromCorrectionId) must
//     equal the raw corrective-feedback id set. Missing ⇒ self-healed into an
//     "Other fixes" group (rule:null) from the raw record; duplicate ⇒ first placement
//     wins, the later reference stripped; invented ⇒ dropped. All logged.
//
// The composed VM satisfies the §10 hard gate by construction:
//   integrity.reportedCorrections === renderedGrammar + renderedVocab + renderedPhrasing.
// stats.corrections is the USER-FACING count and equals renderedGrammar — what the
// Grammar section actually lists — so the header stat, the index "N fixes" badge, and
// the section total always agree; the raw Cambly-reported total lives only in integrity.

import { cstIso, resolveNow } from "./week.js";
import { normalizeQuote } from "./quote.js";
import { cleanCorrectionText } from "./normalize.js";
import {
  summarizeWeek,
  openaiModel,
  buildWeekBundle,
} from "./summarize.js";

export const SCHEMA_VERSION = 1;
/** >30% of quote-guarded items rejected triggers exactly one corrective re-prompt (I-SM ④). */
export const REPROMPT_THRESHOLD = 0.3;

/** The builder self-healed/enforced the Σ-invariant but the arithmetic still failed (should never fire). */
export class BuildIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = "BuildIntegrityError";
    this.stage = "build";
  }
}

/** Quote-guard rejected more than REPROMPT_THRESHOLD of items even after the corrective re-prompt. */
export class SummarizeQualityError extends Error {
  constructor(message, { rejectRatio } = {}) {
    super(message);
    this.name = "SummarizeQualityError";
    this.stage = "summarize";
    this.rejectRatio = rejectRatio;
  }
}

// ── Quote-guard normalization (NFKC + curly→straight + whitespace collapse) ────
// The canonical normalizer lives in ./quote.js and is shared with the renderer's
// re-assert (src/render/esc.js) so the guard and the re-assert can never diverge.
// Re-exported here because build tests import it from this module.
export { normalizeQuote };

/** Per-lesson quote corpus split by side. Feedback (tutor notes) is tutor-side. */
export function quoteCorpus(lesson) {
  const student = [];
  const tutor = [];
  for (const t of lesson.transcript || []) {
    (t.speaker === "student" ? student : tutor).push(t.text);
  }
  for (const m of lesson.chat || []) {
    (m.from === "student" ? student : tutor).push(m.text);
  }
  for (const note of lesson.tutorNotes || []) tutor.push(note);
  return { student, tutor, any: [...student, ...tutor] };
}

/**
 * True iff `quote` is a verbatim (normalized) substring of at least one single line on
 * the requested side. Matching is per-line — never a concatenated corpus — so a quote
 * that spans two turns is correctly rejected (U-QG ⑧). Empty/whitespace-only ⇒ false.
 */
export function quoteMatches(quote, corpus, side = "any") {
  const needle = normalizeQuote(quote);
  if (!needle) return false;
  const lines = corpus[side] || [];
  return lines.some((line) => normalizeQuote(line).includes(needle));
}

// ── Small helpers ──────────────────────────────────────────────────────────────

function intOr0(v) {
  return Number.isFinite(v) ? Math.round(v) : 0;
}

function lessonMap(lessons) {
  const map = new Map();
  for (const l of lessons) map.set(l.lessonId, l);
  return map;
}

const PATTERN_FALLBACK = "Other fixes";

/**
 * A human-readable grammar-habit heading (beta finding 3). A good pattern passes through
 * UNCHANGED ("Past tense", "Subject-verb agreement", "must/try forms"). The degenerate
 * labels the summarizer sometimes emits are repaired: a punctuation-only / empty label
 * ("." , "") → the fallback; a slash-wrapped, hyphen/underscore-slug, or camelCase label
 * ("/tense-with-past-time/", "PAST-TENSE-ERRORS", "pastTense", "past-Tense") → slashes
 * become " & " concept separators, camelCase humps and slug separators become spaces, the
 * result is lower-cased and its first letter capitalized. Case-insensitive so ALL-CAPS and
 * mixed-case slugs normalize too (finding 6). Never returns "." or an empty heading.
 */
export function humanizePattern(pattern) {
  const raw = (typeof pattern === "string" ? pattern : "").trim();
  if (raw.replace(/[^\p{L}\p{N}]/gu, "") === "") return PATTERN_FALLBACK;
  const wrapped = raw.startsWith("/") || raw.endsWith("/");
  const hyphenSlug = /^[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)+$/u.test(raw);
  const camelCase = /^\p{Ll}[\p{L}\p{N}]*\p{Lu}[\p{L}\p{N}]*$/u.test(raw);
  if (!wrapped && !hyphenSlug && !camelCase) return pattern; // already human — leave verbatim
  const out = raw
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" & ")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2") // split camelCase humps
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (out === "") return PATTERN_FALLBACK;
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** A crude inflectional stem: drop a common suffix, then undo a doubled final consonant
 * (watching→watch, watched→watch, running→runn→run, shows→show). Good enough to match a
 * term against a differently-inflected real usage; it is never shown to the user. */
function stemToken(w) {
  const s = w.replace(/(?:ing|ed|es|ly|s)$/u, "");
  return s.replace(/([bcdfghjklmnpqrstvwxyz])\1$/u, "$1");
}

/** Fold to a case/hyphen/whitespace-insensitive comparison form (never shown to the user). */
function foldText(s) {
  return normalizeQuote(s).toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

/** As foldText but also drops punctuation — for loose example↔error-form containment checks. */
function foldLoose(s) {
  return foldText(s).replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
}

const hasStr = (v) => typeof v === "string" && v.trim() !== "";

/**
 * Case-insensitive: does the quote actually contain the vocabulary term (beta finding 3)?
 * Hyphens fold to spaces and an exact (folded) containment wins immediately. Failing that,
 * a term is still "contained" when its tokens' stems appear contiguously in the quote's
 * token stems — so an -ing/-ed/plural/hyphenated inflection of the term counts as a real
 * example ("binge watching" ~ "binge watched", "run late" ~ "running late", "well-being" ~
 * "well being"). The line already passed the verbatim corpus guard, so keeping a genuine
 * usage in a different form is safer than blanking the example and showing the word bare.
 */
export function quoteContainsTerm(quote, term) {
  const q = foldText(quote);
  const t = foldText(term);
  if (t === "") return false;
  if (q.includes(t)) return true; // fast path: exact (hyphen-folded) containment
  const tStems = t.split(" ").filter(Boolean).map(stemToken);
  const qStems = q.split(" ").filter(Boolean).map(stemToken);
  if (tStems.length === 0 || tStems.some((s) => s === "")) return false;
  for (let i = 0; i + tStems.length <= qStems.length; i++) {
    if (tStems.every((s, j) => s === qStems[i + j])) return true;
  }
  return false;
}

// A clean vocabulary example is a short, real, unique usage — never a run-on transcript
// blob, a circular definition, or the very error the page corrects elsewhere (beta finding:
// prefer omission over a bad example). Each check below is one reason to DROP the example.
export const VOCAB_EXAMPLE_MAX_WORDS = 14;
const ERROR_FORM_MIN = 12; // a flagged form shorter than this is too generic to match on

function wordCount(s) {
  return foldText(s).split(" ").filter(Boolean).length;
}

/**
 * True iff the quote is a circular DEFINITION of the term rather than a usage of it —
 * "Gossip means talking about…", "A fad diet is when…". Detected only when the term itself
 * is the grammatical subject immediately followed by a defining copula, so an incidental
 * "means"/"is" elsewhere in a real sentence never trips it.
 */
function definesTerm(quote, term) {
  const q = foldText(quote);
  const t = foldText(term);
  if (!t || !q.startsWith(t + " ")) return false;
  const rest = q.slice(t.length).trim();
  return /^(means?|is|are|refers?\s+to|describes?|stands?\s+for|is\s+when|is\s+a|is\s+the)\b/u.test(rest);
}

/**
 * True iff a content-word bigram repeats inside the example — the signature of a tutor
 * reciting a vocab list ("get together … reservation … get together …") or a comma-spliced
 * run-on. Short words (<3 chars) are ignored so ordinary function words don't false-positive.
 */
function hasRepeatedPhrase(quote) {
  const words = foldText(quote).split(" ").filter((w) => w.length >= 3);
  const seen = new Set();
  for (let i = 0; i + 1 < words.length; i++) {
    const bigram = `${words[i]} ${words[i + 1]}`;
    if (seen.has(bigram)) return true;
    seen.add(bigram);
  }
  return false;
}

/**
 * True iff the example equals or contains (or is contained by) a flagged error/corrected form
 * this week — the student's own corrected sentences and phrasing "said" strings. An example
 * that IS the error the Grammar/Phrasing sections correct must never resurface here as a
 * "usage" (e.g. "I go to school by walk"). A short generic flagged form (< ERROR_FORM_MIN) is
 * skipped so it doesn't match half the corpus.
 */
function matchesErrorForm(quote, errorForms) {
  const q = foldLoose(quote);
  if (!q) return false;
  return errorForms.some((e) => {
    const f = foldLoose(e);
    if (f.length < ERROR_FORM_MIN) return false;
    return q === f || q.includes(f) || f.includes(q);
  });
}

/**
 * The single predicate deciding whether a vocabulary example survives (beta finding: clean
 * short examples only, else omit). An example is KEPT only when it is a real usage of the
 * term (not a definition), reasonably short, internally non-repetitive, unique across the
 * week's cards, and not a flagged error form. Any failure drops the example — the word still
 * renders with its meaning + day.
 * @param {{errorForms:string[], exampleFreq:Map<string,number>}} ctx
 */
function isCleanVocabExample(quote, term, { errorForms, exampleFreq }) {
  if (!hasStr(quote)) return false;
  if (!quoteContainsTerm(quote, term)) return false; // real usage of the term
  if (definesTerm(quote, term)) return false; // not a circular definition
  if (wordCount(quote) > VOCAB_EXAMPLE_MAX_WORDS) return false; // reasonably short
  if (hasRepeatedPhrase(quote)) return false; // not a recited-list / run-on blob
  if ((exampleFreq.get(foldText(quote)) || 0) > 1) return false; // unique across cards
  if (matchesErrorForm(quote, errorForms)) return false; // not a flagged error form
  return true;
}

/**
 * finalAIFeedback → the coach-summary prose string, verbatim. Recent lessons carry an
 * object of prose sections (whatYouDidWell / whatWeCanWorkOn / ideasForPractice); the
 * summary section surfaced as the coach summary is `whatYouDidWell`. Older shapes may
 * carry a plain string. Anything with no usable summary prose → null. We deliberately do
 * NOT fall back to an arbitrary Object.values() section: a criticism-oriented section
 * (e.g. whatWeCanWorkOn) surfaced under the positive coach-summary slot is a semantic
 * mismatch, so only the summary-style key is allowed. A returned value is always a
 * verbatim slice of Cambly's own text (never synthesized), so it is not quote-guarded.
 */
const AI_FEEDBACK_SUMMARY_KEYS = ["whatYouDidWell"];

function aiFeedbackProse(v) {
  if (typeof v === "string") return v.trim() ? v : null;
  if (v && typeof v === "object") {
    for (const key of AI_FEEDBACK_SUMMARY_KEYS) {
      if (typeof v[key] === "string" && v[key].trim()) return v[key];
    }
  }
  return null;
}

// Worksheet/exercise markers Cambly sometimes pastes after the real coaching sentences.
// These fire ONLY on lines that are STRUCTURALLY drill material, never on ordinary coaching
// prose (beta findings 1 + 2). A leading decorative emoji is stripped before matching so a
// celebratory opener ("🎉 Amazing progress this week! …") is judged on its words, and the
// drill keywords are anchored to line-start so "exercise"/"choose the correct" never fire as
// mid-sentence words ("you did this breathing exercise 3 times").
const LEADING_EMOJI = /^(?:\p{Extended_Pictographic}[\uFE0F\u200D]*)+\s*/u;
const SECTION_TITLE_MAX = 56;

// HARD drill markers — unambiguous worksheet content; always a boundary (tested post
// emoji-strip so an emoji-led "✏️ Exercise 1: …" still matches the line-start anchor).
const DRILL_MARKER = [
  /^exercise\s*\d/i,                        // "Exercise 1: Choose the Correct Verb"
  /^choose the correct\b/i,                 // multiple-choice drill instruction
  /^fix the .{0,24}\bmistakes\b/i,          // "Fix the … Mistakes" header
  /_{4,}/,                                   // a fill-in-the-blank run  ______  /  → ______
  /^\d+[.)]\s+[^\n]*\([^)]*\/[^)]*\)/,       // "1. Yesterday I (go / went / gone) home." drill item
];

/** True iff a line is an emoji-led section title (short, no sentence-ending punctuation). */
function isEmojiSectionTitle(t) {
  if (!LEADING_EMOJI.test(t)) return false;
  const bare = t.replace(LEADING_EMOJI, "").trim();
  if (!bare || bare.length > SECTION_TITLE_MAX) return false;
  return !/[.!?…]$/u.test(bare); // a real coaching sentence ends in . ! ? …
}

/** "hard" (drill marker), "soft" (emoji section title), or "none" for a coaching line. */
function worksheetBoundary(rawLine) {
  const t = rawLine.trim();
  if (!t) return "none";
  const bare = t.replace(LEADING_EMOJI, "").trim() || t;
  if (DRILL_MARKER.some((re) => re.test(bare))) return "hard";
  if (isEmojiSectionTitle(t)) return "soft";
  return "none";
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
 */
export function stripWorksheet(text) {
  if (typeof text !== "string") return text;
  const lines = text.split("\n");
  let cut = -1;
  let kind = "none";
  for (let i = 0; i < lines.length; i++) {
    const k = worksheetBoundary(lines[i]);
    if (k !== "none") {
      cut = i;
      kind = k;
      break;
    }
  }
  if (cut === -1) return text; // no worksheet tail — unchanged
  const kept = lines.slice(0, cut).join("\n").replace(/\s+$/u, "");
  if (kept !== "") return kept;
  // Nothing kept: a HARD drill marker as the first content line ⇒ all worksheet ⇒ null; a
  // leading emoji title never erases genuine coaching (finding 1) ⇒ keep the text as-is.
  return kind === "hard" ? null : text;
}

/** Normalize a line for sign-off duplicate detection: letters/digits/space, lower-case. */
function signoffKey(s) {
  return normalizeQuote(typeof s === "string" ? s : "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SIGNOFF_MIN = 12; // avoid stripping a short line that is only incidentally a substring

/**
 * Show the tutor's closing line ONCE (beta finding 2). The class card already surfaces the
 * moment/highlight and the tutor note; when a coaching line in the Focus box repeats that
 * same sign-off it is stripped from the Focus box (the class highlight stays authoritative).
 * Comparison is punctuation/emoji-insensitive containment with a min-length guard so a short
 * genuine line is never removed. Returns tutorFocus with any duplicate lines cleared.
 */
function dedupeFocusSignoff(tf, highlights) {
  if (!tf || typeof tf !== "object") return tf;
  const others = highlights.map(signoffKey).filter((s) => s.length >= SIGNOFF_MIN);
  if (others.length === 0) return tf;
  const strip = (text) => {
    if (typeof text !== "string" || text.trim() === "") return text;
    const kept = text
      .split("\n")
      .filter((line) => {
        const n = signoffKey(line);
        if (n.length < SIGNOFF_MIN) return true; // too short to be a sign-off duplicate
        return !others.some((o) => o === n || o.includes(n) || n.includes(o));
      })
      .join("\n")
      .replace(/\s+$/u, "");
    return kept.trim() === "" ? null : kept;
  };
  return { ...tf, aiFeedback: strip(tf.aiFeedback), tutorNotes: strip(tf.tutorNotes) };
}

/**
 * Per-class coaching block (WeekVM.tutorFocus, §10 contract addition), lifted VERBATIM
 * from the lesson's normalized ai_tutor feedback: the AI coach summary, the tutor's
 * prose note, its Chinese translation, and the suggested next focus. This is Cambly's
 * own text — NOT a learner-error claim — so it is never routed through the quote-guard.
 * Returns null for lessons with no ai_tutor feedback (the older data shape).
 */
function tutorFocusOf(lesson) {
  const f = lesson.aiTutorFeedback;
  if (!f || typeof f !== "object") return null;
  return {
    // Worksheet/exercise tails are stripped so the Focus box shows coaching prose only.
    aiFeedback: stripWorksheet(aiFeedbackProse(f.finalAIFeedback)),
    tutorNotes: stripWorksheet(f.tutorNotes ?? null),
    tutorNotesZh: f.tutorNotesTranslated ?? null,
    nextFocus: f.finalSuggestedNextLesson ?? null,
  };
}

/** id → { said, fix, why, lessonId } for every raw correction across the week (the Σ anchor). */
function correctionIndex(lessons) {
  const idx = new Map();
  for (const l of lessons) {
    for (const c of l.corrections || []) {
      if (c && c.id != null && !idx.has(c.id)) {
        idx.set(c.id, { id: c.id, said: c.said, fix: c.fix, why: c.why, lessonId: l.lessonId });
      }
    }
  }
  return idx;
}

// ── The builder ─────────────────────────────────────────────────────────────────

/**
 * Compose the canonical WeekVM from normalized lessons + the LLM wire object, running
 * both integrity gates. Pure function of its inputs (clock injected via `now`).
 *
 * @param {object} args
 * @param {{weekId,weekLabel,startDate,endDate}} args.window
 * @param {object[]} args.lessons       normalized lessons for the week
 * @param {object}   args.wire          the validated LLM wire output
 * @param {string}  [args.model]
 * @param {number}  [args.promptTokens]
 * @param {number}  [args.now]          epoch ms for publishedAt (FAKE_NOW seam)
 * @returns {{weekVM:object, rejectRatio:number}}
 */
export function buildWeekVM({ window, lessons, wire, model = openaiModel(), promptTokens = 0, now = resolveNow() }) {
  const byLesson = lessonMap(lessons);
  const corrById = correctionIndex(lessons);
  const rawSigmaSet = new Set(corrById.keys());

  const rejects = [];
  const logReject = (entry) => rejects.push({ dropped: false, ...entry });

  let quoteItemsTotal = 0;
  let quoteItemsRejected = 0;
  const guard = (quote, corpus, side, meta) => {
    quoteItemsTotal += 1;
    const ok = quoteMatches(quote, corpus, side);
    if (!ok) {
      quoteItemsRejected += 1;
      logReject({ type: "quote-guard", dropped: true, quote, quoteBy: side, reason: "no verbatim match", ...meta });
    }
    return ok;
  };

  // ── classes[] — ONE card per normalized lesson (builder-owned, §10). The wire
  // supplies only moment{text, quotes} + tutorNote, matched to its lesson by id; an
  // omitted wire class still yields a card (no moment), a duplicate wire class is
  // ignored. Every scalar comes from the lesson, never the LLM. Each moment quote is a
  // highlight guarded ONLY against the lesson's real transcript corpus (the same corpus
  // vocabulary/phrasing use) — NOT against the short moment.text prose. The summarizer's
  // narrative rarely embeds the quote verbatim, so the old moment.text-substring guard
  // rejected nearly every moment and spammed the reject log; a corpus-verbatim line the
  // prose didn't embed is still a legitimate highlight (it simply renders without an
  // inline <q> mark), and when none qualify the moment renders its text with no
  // highlights. tutorFocus is Cambly's own coaching text, lifted verbatim (never guarded).
  const wireClasses = Array.isArray(wire.classes) ? wire.classes : [];
  const wireByLesson = new Map();
  for (const c of wireClasses) {
    if (c && byLesson.has(c.lessonId) && !wireByLesson.has(c.lessonId)) {
      wireByLesson.set(c.lessonId, c);
    }
  }
  const classes = lessons
    .map((l) => {
      const c = wireByLesson.get(l.lessonId) || {};
      const corpus = quoteCorpus(l);
      const momentText = c.moment?.text ?? "";
      const rawQuotes = Array.isArray(c.moment?.quotes) ? c.moment.quotes : [];
      // Corpus-only guard (see the section comment): a highlight must be a verbatim
      // transcript line, but it need NOT appear in moment.text.
      const quotes = rawQuotes.filter((q) =>
        guard(q, corpus, "any", { section: "moment", lessonId: l.lessonId }),
      );
      const tutorNote = c.tutorNote ?? null;
      // The class highlight (moment/tutorNote) is authoritative; a coaching line in the
      // Focus box that repeats the same sign-off is stripped so it shows once (finding 2).
      const tutorFocus = dedupeFocusSignoff(tutorFocusOf(l), [momentText, tutorNote]);
      return {
        lessonId: l.lessonId,
        startAt: l.startAtCST,
        minutes: intOr0(l.minutes),
        topic: l.topic || "",
        tutor: l.tutor || "",
        stats: {
          wpm: intOr0(l.stats?.wpm),
          talkPct: intOr0(l.stats?.talkRatio),
          words: intOr0(l.stats?.uniqueWords),
          fixes: (l.corrections || []).length,
        },
        // Emit moment only when there is real text — an empty {text:""} object would
        // trip the renderer's non-empty-text gate; null cleanly renders no highlight.
        moment: momentText.trim() ? { text: momentText, quotes } : null,
        tutorNote,
        tutorFocus,
      };
    })
    .sort((a, b) =>
      String(a.startAt).localeCompare(String(b.startAt)) ||
      String(a.lessonId).localeCompare(String(b.lessonId)),
    );

  // ── vocabulary[] — guard the quote (side = quoteBy), then assign ids ──────────
  const wireVocab = Array.isArray(wire.vocabulary) ? wire.vocabulary : [];
  // Flagged error/corrected forms this week: the raw corrections' student sentences plus any
  // phrasing "said". An example that IS one of these is the error corrected elsewhere on the
  // page, so it must never resurface as a vocabulary usage example.
  const errorForms = [];
  for (const raw of corrById.values()) if (hasStr(raw.said)) errorForms.push(raw.said);
  for (const p of Array.isArray(wire.phrasing) ? wire.phrasing : []) {
    if (p && hasStr(p.said)) errorForms.push(p.said);
  }
  // Fold-count every candidate example so an example repeated verbatim across two cards (a
  // tutor reciting a vocab list) is dropped from ALL of them, not just the later copies.
  const exampleFreq = new Map();
  for (const v of wireVocab) {
    if (v && hasStr(v.quote)) {
      const k = foldText(v.quote);
      exampleFreq.set(k, (exampleFreq.get(k) || 0) + 1);
    }
  }
  const vocabulary = [];
  wireVocab.forEach((v) => {
    const l = byLesson.get(v.lessonId);
    const corpus = l ? quoteCorpus(l) : { student: [], tutor: [], any: [] };
    const side = v.quoteBy === "tutor" ? "tutor" : "student";
    if (!guard(v.quote, corpus, side, { section: "vocabulary", lessonId: v.lessonId })) return;
    // The quote is a verbatim line — but a flashcard example is only KEPT when it is a real,
    // short, unique usage of the term and not the error the page corrects (beta finding:
    // prefer omission over a bad example). A run-on transcript blob, a circular definition,
    // an ASR-garbled or unrelated line, a duplicate across cards, or a flagged error form is
    // dropped: the word still renders with its meaning + day, just without a bad sentence.
    const hasExample = isCleanVocabExample(v.quote, v.term, { errorForms, exampleFreq });
    if (!hasExample) {
      logReject({ type: "vocab-example", dropped: false, section: "vocabulary", lessonId: v.lessonId, term: v.term, quote: v.quote, reason: "example not a clean short unique non-error usage of the term → dropped" });
    }
    vocabulary.push({
      id: `v-${vocabulary.length + 1}`,
      term: v.term,
      meaning: v.meaning,
      quote: hasExample ? v.quote : null,
      quoteBy: hasExample ? side : null,
      lessonId: v.lessonId,
      fromCorrectionId: v.fromCorrectionId ?? null,
    });
  });

  // ── phrasing[] — guard said (student side), then assign ids ───────────────────
  const wirePhrasing = Array.isArray(wire.phrasing) ? wire.phrasing : [];
  const phrasing = [];
  wirePhrasing.forEach((p) => {
    const l = byLesson.get(p.lessonId);
    const corpus = l ? quoteCorpus(l) : { student: [], tutor: [], any: [] };
    if (!guard(p.said, corpus, "student", { section: "phrasing", lessonId: p.lessonId })) return;
    phrasing.push({
      id: `ph-${phrasing.length + 1}`,
      said: p.said,
      better: p.better,
      why: p.why,
      lessonId: p.lessonId,
      fromCorrectionId: p.fromCorrectionId ?? null,
    });
  });

  // ── Σ placement — grammar first, so grammar wins duplicate ties ───────────────
  const claimed = new Set();
  const wireGroups = Array.isArray(wire.grammarGroups) ? wire.grammarGroups : [];
  const grammarGroups = [];
  for (const g of wireGroups) {
    const items = [];
    for (const it of Array.isArray(g.items) ? g.items : []) {
      const cid = it.correctionId;
      const raw = corrById.get(cid);
      if (!raw) {
        logReject({ type: "unknown-correction", dropped: true, section: "grammar", correctionId: cid, reason: "correctionId not in raw set" });
        continue;
      }
      if (claimed.has(cid)) {
        logReject({ type: "duplicate-correction", dropped: true, section: "grammar", correctionId: cid, reason: "already placed (first wins)" });
        continue;
      }
      claimed.add(cid);
      items.push({
        id: `g-${cid}`,
        said: raw.said,
        fix: raw.fix,
        // it.why is LLM-authored — the field where a JSON serialization artifact bled in
        // (beta finding 1). Clean it here too (defense in depth beyond the normalize boundary,
        // since raw said/fix are already boundary-cleaned); "" when nothing clean survives.
        why: cleanCorrectionText(it.why) ?? "",
        lessonId: raw.lessonId,
        correctionId: cid,
      });
    }
    if (items.length) grammarGroups.push({ pattern: humanizePattern(g.pattern), rule: g.rule ?? null, items });
  }

  // ── Reconcile vocab/phrasing fromCorrectionId against the claim set ───────────
  const reconcileRef = (item, section) => {
    const cid = item.fromCorrectionId;
    if (cid == null) return;
    if (!rawSigmaSet.has(cid)) {
      logReject({ type: "unknown-correction", dropped: false, section, id: item.id, correctionId: cid, reason: "fromCorrectionId not in raw set → nulled" });
      item.fromCorrectionId = null;
      return;
    }
    if (claimed.has(cid)) {
      logReject({ type: "duplicate-correction", dropped: false, section, id: item.id, correctionId: cid, reason: "already placed (first wins) → nulled" });
      item.fromCorrectionId = null;
      return;
    }
    claimed.add(cid);
  };
  for (const v of vocabulary) reconcileRef(v, "vocabulary");
  for (const p of phrasing) reconcileRef(p, "phrasing");

  // ── Σ self-heal — any raw correction not yet placed goes to "Other fixes" ─────
  const missing = [...rawSigmaSet].filter((cid) => !claimed.has(cid)).sort();
  if (missing.length) {
    const items = missing.map((cid) => {
      const raw = corrById.get(cid);
      claimed.add(cid);
      logReject({ type: "self-heal", dropped: false, section: "grammar", correctionId: cid, reason: "unplaced correction rendered in Other fixes" });
      return { id: `g-${cid}`, said: raw.said, fix: raw.fix, why: cleanCorrectionText(raw.why) ?? "", lessonId: raw.lessonId, correctionId: cid };
    });
    grammarGroups.push({ pattern: "Other fixes", rule: null, items });
  }

  // ── practice[] — lineage gate (grammar-independent). A sourceId resolves against
  // ANY surviving rendered item — a grammar item id, a vocabulary id, a phrasing id, a
  // raw correction id, OR a lessonId — so a week with vocabulary + phrasing but zero
  // grammar still yields practice (the summarizer cites the lessonId the drill came
  // from). An item is kept when AT LEAST ONE of its sourceIds resolves; it is dropped
  // only when sourceIds is empty or nothing resolves. This retires the old "every
  // sourceId must resolve" cascade that zeroed practice whenever grammar was empty.
  const idToLesson = new Map();
  for (const l of lessons) idToLesson.set(l.lessonId, l.lessonId);
  for (const [cid, raw] of corrById) idToLesson.set(cid, raw.lessonId);
  for (const g of grammarGroups) for (const it of g.items) idToLesson.set(it.id, it.lessonId);
  for (const v of vocabulary) idToLesson.set(v.id, v.lessonId);
  for (const p of phrasing) idToLesson.set(p.id, p.lessonId);
  const validSourceId = (id) => idToLesson.has(id);

  const wirePractice = Array.isArray(wire.practice) ? wire.practice : [];
  const practice = [];
  wirePractice.forEach((pr) => {
    const sourceIds = Array.isArray(pr.sourceIds) ? pr.sourceIds : [];
    const firstResolved = sourceIds.find(validSourceId);
    if (firstResolved === undefined) {
      logReject({ type: "lineage", dropped: true, section: "practice", reason: sourceIds.length === 0 ? "empty sourceIds" : `no sourceId resolves to a surviving item (${JSON.stringify(sourceIds)})`, prompt: pr.prompt });
      return;
    }
    practice.push({
      id: `pr-${practice.length + 1}`,
      format: pr.format,
      prompt: pr.prompt,
      cue: pr.cue ?? null,
      answer: pr.answer,
      why: pr.why,
      lessonId: idToLesson.get(firstResolved) ?? null,
      sourceIds,
    });
  });

  // ── stats + integrity ─────────────────────────────────────────────────────────
  const renderedGrammar = grammarGroups.reduce((n, g) => n + g.items.length, 0);
  const renderedVocab = vocabulary.filter((v) => v.fromCorrectionId != null).length;
  const renderedPhrasing = phrasing.filter((p) => p.fromCorrectionId != null).length;
  const reportedCorrections = rawSigmaSet.size;
  const rejectedCount = rejects.filter((r) => r.dropped).length;

  const sigmaSum = renderedGrammar + renderedVocab + renderedPhrasing;
  if (sigmaSum !== reportedCorrections) {
    throw new BuildIntegrityError(
      `Σ-invariant failed: reported ${reportedCorrections} !== grammar ${renderedGrammar} + vocab ${renderedVocab} + phrasing ${renderedPhrasing}`,
    );
  }

  const stats = {
    classes: lessons.length,
    // Summed from the lessons (not the rendered cards) so minutes can never drift
    // from classes when a wire class is omitted or duplicated (§10, builder-derived).
    minutes: lessons.reduce((n, l) => n + intOr0(l.minutes), 0),
    // User-facing count == what the Grammar section lists (beta finding 4), so the header
    // stat, the index "N fixes" badge, and the section total agree. The raw Cambly-reported
    // Σ-set size stays in integrity.reportedCorrections (below), never surfaced as a stat.
    corrections: renderedGrammar,
    expressions: vocabulary.length,
  };

  const weekVM = {
    schemaVersion: SCHEMA_VERSION,
    weekId: window.weekId,
    weekLabel: window.weekLabel,
    startDate: window.startDate,
    endDate: window.endDate,
    publishedAt: cstIso(now),
    isEmpty: false,
    stats,
    classes,
    vocabulary,
    grammarGroups,
    phrasing,
    practice,
    integrity: {
      reportedCorrections,
      renderedGrammar,
      renderedVocab,
      renderedPhrasing,
      rejectedCount,
    },
    build: { model, promptTokens: intOr0(promptTokens), rejects },
  };

  const rejectRatio = quoteItemsTotal === 0 ? 0 : quoteItemsRejected / quoteItemsTotal;
  return { weekVM, rejectRatio };
}

/** The isEmpty:true stub for a week with no lessons — same §10 shape, all arrays empty. */
export function buildEmptyWeekVM({ window, model = openaiModel(), now = resolveNow() }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    weekId: window.weekId,
    weekLabel: window.weekLabel,
    startDate: window.startDate,
    endDate: window.endDate,
    publishedAt: cstIso(now),
    isEmpty: true,
    stats: { classes: 0, minutes: 0, corrections: 0, expressions: 0 },
    classes: [],
    vocabulary: [],
    grammarGroups: [],
    phrasing: [],
    practice: [],
    integrity: { reportedCorrections: 0, renderedGrammar: 0, renderedVocab: 0, renderedPhrasing: 0, rejectedCount: 0 },
    build: { model, promptTokens: 0, rejects: [] },
  };
}

/**
 * End-to-end weekly generation: summarize → build → (one corrective re-prompt if the
 * quote-guard rejected > REPROMPT_THRESHOLD of items) → build again. An empty week
 * short-circuits with the stub and makes zero LLM calls.
 *
 * @returns {Promise<{weekVM:object, rejectRatio:number, llmCalls:number, reprompted:boolean}>}
 */
export async function generateWeekVM({
  window,
  lessons,
  model = openaiModel(),
  now = resolveNow(),
  summarize = summarizeWeek,
  ...summarizeOpts
} = {}) {
  if (!lessons || lessons.length === 0) {
    return { weekVM: buildEmptyWeekVM({ window, model, now }), rejectRatio: 0, llmCalls: 0, reprompted: false };
  }

  const bundle = buildWeekBundle(lessons);
  let llmCalls = 0;

  let sum = await summarize({ bundle, model, ...summarizeOpts });
  llmCalls += 1;
  let built = buildWeekVM({ window, lessons, wire: sum.wire, model: sum.model, promptTokens: sum.promptTokens, now });

  if (built.rejectRatio > REPROMPT_THRESHOLD) {
    const rejections = built.weekVM.build.rejects.filter((r) => r.type === "quote-guard");
    sum = await summarize({ bundle, model, rejections, ...summarizeOpts });
    llmCalls += 1;
    built = buildWeekVM({ window, lessons, wire: sum.wire, model: sum.model, promptTokens: sum.promptTokens, now });
    if (built.rejectRatio > REPROMPT_THRESHOLD) {
      throw new SummarizeQualityError(
        `quote-guard rejected ${(built.rejectRatio * 100).toFixed(0)}% of items after re-prompt (> ${REPROMPT_THRESHOLD * 100}%)`,
        { rejectRatio: built.rejectRatio },
      );
    }
    return { weekVM: built.weekVM, rejectRatio: built.rejectRatio, llmCalls, reprompted: true };
  }

  return { weekVM: built.weekVM, rejectRatio: built.rejectRatio, llmCalls, reprompted: false };
}

// Re-export the bundle builder (single source in summarize.js) for callers/tests.
export { buildWeekBundle };
