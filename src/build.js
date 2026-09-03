// src/build.js — builder (TECH §3 "builder", §10 canonical WeekVM contract).
//
// The builder owns BOTH integrity gates and composes the canonical WeekVM from
// (a) the normalized lessons and (b) the LLM's narrow wire output. It writes no
// HTML — rendering is the frontend renderer's job (§F1). Enforcement points:
//
//   Gate #1 quote-guard  — every ▣ field (vocabulary.quote, phrasing.said, each
//     classes[].moment.quotes entry, each transcript-derived grammar `said`, each
//     review quote) must substring-match ONE line of the lesson's quote corpus after
//     NFKC + curly→straight + whitespace-collapse, compared case-insensitively (the
//     LLM capitalises the first word of a mid-sentence span), on the side matching
//     quoteBy. Fail ⇒ dropped + logged (review quotes: nulled, item kept), never
//     rendered. Practice items carry no verbatim field and are gated by lineage.
//
//   Gate #2 Σ-invariant  — the multiset of placed correction ids (anchored grammar
//     items ∪ non-null vocabulary.fromCorrectionId ∪ non-null phrasing.fromCorrectionId)
//     must equal the raw corrective-feedback id set. Missing ⇒ self-healed into an
//     "Other fixes" group (rule:null) from the raw record; duplicate ⇒ first placement
//     wins, the later reference stripped; invented ⇒ dropped. All logged. Transcript-
//     derived grammar items (correctionId null, derived:true) sit OUTSIDE Σ.
//
// The composed VM satisfies the §10 hard gate by construction:
//   integrity.reportedCorrections === anchoredGrammar + renderedVocab + renderedPhrasing.
// stats.corrections is the USER-FACING count and equals renderedGrammar (anchored +
// derived) — what the Grammar section actually lists — so the header stat, the index
// "N fixes" badge, and the section total always agree; the raw Cambly-reported total
// lives only in integrity.

import { cstIso, resolveNow } from "./week.js";
import { normalizeQuote } from "./quote.js";
import { cleanCorrectionText } from "./normalize.js";
import { stripWorksheet, stripWorksheetStrict } from "./coach.js";
import {
  summarizeWeek,
  openaiModel,
  buildWeekBundle,
} from "./summarize.js";
// Block composition (grammar heading · tutorFocus · review / level / plan) lives in
// ./compose.js; the builder keeps the gates, the Σ placement and the VM assembly.
import {
  hasStr,
  humanizePattern,
  tutorFocusOf,
  dedupeFocusSignoff,
  composeReview,
  composeLevel,
  composePlan,
  nextWeekLabel,
} from "./compose.js";

// Re-exported here because build tests and older callers import them from this module.
export { humanizePattern, nextWeekLabel };

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

/**
 * Per-lesson quote corpus split by side. Transcript lines come from the normalizer's
 * merged `segments` (whole speaker turns — what the LLM read and quoted from) when
 * present, else the raw `transcript` fragments. Chat is per side; feedback (tutor
 * notes) is tutor-side.
 */
export function quoteCorpus(lesson) {
  const student = [];
  const tutor = [];
  const lines =
    Array.isArray(lesson.segments) && lesson.segments.length ? lesson.segments : lesson.transcript || [];
  for (const t of lines) {
    (t.speaker === "student" ? student : tutor).push(t.text);
  }
  for (const m of lesson.chat || []) {
    (m.from === "student" ? student : tutor).push(m.text);
  }
  for (const note of lesson.tutorNotes || []) tutor.push(note);
  return { student, tutor, any: [...student, ...tutor] };
}

const EMPTY_CORPUS = Object.freeze({ student: [], tutor: [], any: [] });

/**
 * True iff `quote` is a verbatim (normalized) substring of at least one single line on
 * the requested side. Matching is per-line — never a concatenated corpus — so a quote
 * that spans two turns is correctly rejected (U-QG ⑧). The comparison is CASE-
 * INSENSITIVE (both sides lower-cased after `normalizeQuote`, which itself stays
 * case-preserving): the LLM capitalises the first word of a mid-sentence span ("If I
 * have two choice…" vs "…think if I have two choice…") and that is not a real
 * mismatch. Empty/whitespace-only ⇒ false.
 */
export function quoteMatches(quote, corpus, side = "any") {
  const needle = normalizeQuote(quote).toLowerCase();
  if (!needle) return false;
  const lines = corpus[side] || [];
  return lines.some((line) => normalizeQuote(line).toLowerCase().includes(needle));
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

const WORD_CHAR = /[\p{L}\p{N}']/u;

/**
 * Index just past a LEADING occurrence of the (folded) term in the lower-cased quote, or -1.
 * An exact match ending at a word boundary wins; otherwise the quote's leading word tokens
 * must stem-match the term's tokens one for one ("Tourist traps, …" ~ "tourist trap",
 * "well-being" ~ "well being"), with only whitespace or a hyphen between them.
 */
function leadingTermEnd(q, t) {
  if (q.startsWith(t) && !WORD_CHAR.test(q.charAt(t.length))) return t.length;
  const tStems = t.split(" ").filter(Boolean).map(stemToken);
  if (tStems.length === 0 || tStems.some((s) => s === "")) return -1;
  const words = /[\p{L}\p{N}']+/gu; // fresh per call: a global regex carries lastIndex state
  let end = 0;
  for (const stem of tStems) {
    const m = words.exec(q);
    if (!m || stemToken(m[0]) !== stem || !/^[\s-]*$/u.test(q.slice(end, m.index))) return -1;
    end = m.index + m[0].length;
  }
  return end;
}

// A leading term followed by one of these introduces a GLOSS, not a usage: "Tourist trap,
// a place that…", "attire/ clothes you wear", "Paradox: a situation…", "term - gloss",
// "term — gloss", "term (gloss)". A hyphen counts only with whitespace beside it, so a
// hyphenated compound ("tourist-trap") is never mistaken for a separator.
const GLOSS_SEPARATOR = /^\s*(?:[,:/(]|[—–]|\s-|-\s)/u;
const DEFINING_COPULA = /^(means?|is|are|refers?\s+to|describes?|stands?\s+for|is\s+when|is\s+a|is\s+the)\b/u;

/**
 * True iff the quote is a DEFINITION of the term rather than a usage of it — either the
 * dictionary shape "Gossip means talking about…" / "A fad diet is when…" (the term as the
 * subject, immediately followed by a defining copula) or the glossary shape "Tourist trap, a
 * place that…" / "attire/ clothes you wear" / "Paradox: a situation…" (the term, then a
 * separator, then the gloss). Case-insensitive; the term may be plural/inflected exactly as
 * quoteContainsTerm allows. An incidental "means"/"is"/comma later in a real sentence never
 * trips it, because the term must open the line.
 */
function definesTerm(quote, term) {
  const q = normalizeQuote(quote).toLowerCase(); // hyphens kept: " - " is a separator here
  const t = foldText(term);
  if (!t) return false;
  const end = leadingTermEnd(q, t);
  if (end === -1) return false;
  const rest = q.slice(end);
  if (GLOSS_SEPARATOR.test(rest)) return true;
  return /^\s/u.test(rest) && DEFINING_COPULA.test(rest.trim());
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

// Worksheet stripping lives in ./coach.js (shared with the summarizer's bundle so the
// Focus box and the LLM's input can never disagree about what counts as coaching).
// Re-exported here because build tests and older callers import it from this module.
export { stripWorksheet, stripWorksheetStrict };

// Generic lesson-plan titles that say nothing about the class ("Pro Lesson"). Only for
// these does the LLM's specific title (RULE 12) stand in for the topic on the class card.
const GENERIC_TOPICS = new Set(["", "pro lesson", "kickoff conversation", "conversation"]);
const TITLE_MAX_WORDS = 12;

/** True iff a lesson topic is missing or one of Cambly's generic lesson-plan titles. */
export function isGenericTopic(topic) {
  return GENERIC_TOPICS.has(foldText(typeof topic === "string" ? topic : ""));
}

/**
 * classes[].title — the LLM's specific 3–7 word title of what the class was about, used
 * ONLY when the lesson topic is generic. A blank, generic ("Pro Lesson") or over-long wire
 * title yields null, and a specific topic always wins (title null).
 */
function classTitle(topic, wireTitle) {
  if (!isGenericTopic(topic) || !hasStr(wireTitle)) return null;
  const t = wireTitle.trim();
  if (isGenericTopic(t) || wordCount(t) > TITLE_MAX_WORDS) return null;
  return t;
}

/**
 * The LLM-authored model sentence for a vocabulary card (RULE 8), shown ONLY when no clean
 * verbatim quote survived. Kept iff it is a short (≤ VOCAB_EXAMPLE_MAX_WORDS) real usage of
 * the term that is neither a definition nor a flagged error form; else null.
 */
function vocabExampleOf(example, term, errorForms) {
  if (!hasStr(example)) return null;
  if (!quoteContainsTerm(example, term)) return null;
  if (definesTerm(example, term)) return null;
  if (wordCount(example) > VOCAB_EXAMPLE_MAX_WORDS) return null;
  if (matchesErrorForm(example, errorForms)) return null;
  return example.trim();
}

/** RULE 6 caps for transcript-derived grammar items. */
export const DERIVED_GRAMMAR_MAX = 12;
export const DERIVED_SAID_MAX_WORDS = 25;

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
  // `dropped:false` marks a guarded field whose miss nulls the quote but keeps the item
  // (review quotes); the miss still counts toward the corrective re-prompt ratio.
  const guard = (quote, corpus, side, { dropped = true, ...meta } = {}) => {
    quoteItemsTotal += 1;
    const ok = quoteMatches(quote, corpus, side);
    if (!ok) {
      quoteItemsRejected += 1;
      const reason = dropped ? "no verbatim match" : "no verbatim match → quote nulled, item kept";
      logReject({ type: "quote-guard", dropped, quote, quoteBy: side, reason, ...meta });
    }
    return ok;
  };
  // One corpus per lesson, built lazily and shared by every guarded section.
  const corpusCache = new Map();
  const corpusFor = (lessonId) => {
    if (!byLesson.has(lessonId)) return EMPTY_CORPUS;
    if (!corpusCache.has(lessonId)) corpusCache.set(lessonId, quoteCorpus(byLesson.get(lessonId)));
    return corpusCache.get(lessonId);
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
      const corpus = corpusFor(l.lessonId);
      const momentText = c.moment?.text ?? "";
      const rawQuotes = Array.isArray(c.moment?.quotes) ? c.moment.quotes : [];
      // Corpus-only guard (see the section comment): a highlight must be a verbatim
      // transcript line, but it need NOT appear in moment.text.
      const quotes = rawQuotes.filter((q) =>
        guard(q, corpus, "any", { section: "moment", lessonId: l.lessonId }),
      );
      const focus = tutorFocusOf(l);
      // The tutor's note is shown ONCE: when Cambly's own tutorNotes reach the Focus box
      // (verbatim), the wire tutorNote — at best a copy, at worst a topic summary — is dropped.
      const tutorNote = hasStr(focus?.tutorNotes) ? null : c.tutorNote ?? null;
      // The class highlight (moment/tutorNote) is authoritative; a coaching line in the
      // Focus box that repeats the same sign-off is stripped so it shows once (finding 2).
      const tutorFocus = dedupeFocusSignoff(focus, [momentText, tutorNote]);
      return {
        lessonId: l.lessonId,
        startAt: l.startAtCST,
        minutes: intOr0(l.minutes),
        topic: l.topic || "",
        // RULE 12: a specific LLM title stands in ONLY for a generic topic ("Pro Lesson").
        title: classTitle(l.topic, c.title),
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
  // …and the transcript-derived grammar candidates' own `said` spans (RULE 6).
  for (const g of Array.isArray(wire.grammarGroups) ? wire.grammarGroups : []) {
    for (const it of Array.isArray(g?.items) ? g.items : []) if (it && hasStr(it.said)) errorForms.push(it.said);
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
    const corpus = corpusFor(v.lessonId);
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
      // RULE 8: the LLM's model sentence fills in ONLY when no clean verbatim usage survived.
      example: hasExample ? null : vocabExampleOf(v.example, v.term, errorForms),
      lessonId: v.lessonId,
      fromCorrectionId: v.fromCorrectionId ?? null,
    });
  });

  // ── phrasing[] — guard said (student side), then assign ids ───────────────────
  const wirePhrasing = Array.isArray(wire.phrasing) ? wire.phrasing : [];
  const phrasing = [];
  wirePhrasing.forEach((p) => {
    if (!guard(p.said, corpusFor(p.lessonId), "student", { section: "phrasing", lessonId: p.lessonId })) return;
    phrasing.push({
      id: `ph-${phrasing.length + 1}`,
      said: p.said,
      better: p.better,
      why: p.why,
      lessonId: p.lessonId,
      fromCorrectionId: p.fromCorrectionId ?? null,
    });
  });

  // ── RULE 6 — transcript-derived grammar items (correctionId null) ─────────────
  // The LLM's own said/fix for an error it spotted in the student's speech. Accepted
  // only when `said` is a verbatim STUDENT span (case-insensitive corpus guard), the
  // span is short, `fix` actually differs, the lesson is this week's, the span is not a
  // duplicate, and the week-wide cap holds. Ids "g-d<n>", derived:true, OUTSIDE Σ.
  const derivedSeen = new Set();
  let derivedCount = 0;
  const deriveGrammarItem = (it) => {
    const drop = (reason) => {
      logReject({ type: "derived-grammar", dropped: true, section: "grammar", lessonId: it.lessonId ?? null, said: it.said ?? null, reason });
      return null;
    };
    if (!byLesson.has(it.lessonId)) return drop("lessonId not in this week");
    if (!hasStr(it.said) || !hasStr(it.fix)) return drop("said/fix empty");
    if (wordCount(it.said) > DERIVED_SAID_MAX_WORDS) return drop(`said longer than ${DERIVED_SAID_MAX_WORDS} words`);
    if (foldLoose(it.said) === foldLoose(it.fix)) return drop("fix identical to said");
    if (derivedSeen.has(foldLoose(it.said))) return drop("duplicate derived said");
    if (derivedCount >= DERIVED_GRAMMAR_MAX) return drop(`more than ${DERIVED_GRAMMAR_MAX} derived items`);
    if (!guard(it.said, corpusFor(it.lessonId), "student", { section: "grammar", lessonId: it.lessonId })) return null;
    derivedSeen.add(foldLoose(it.said));
    derivedCount += 1;
    return {
      id: `g-d${derivedCount}`,
      said: it.said,
      fix: it.fix,
      why: cleanCorrectionText(it.why) ?? "",
      lessonId: it.lessonId,
      correctionId: null,
      derived: true,
    };
  };

  // ── Σ placement — grammar first, so grammar wins duplicate ties ───────────────
  const claimed = new Set();
  const wireGroups = Array.isArray(wire.grammarGroups) ? wire.grammarGroups : [];
  const grammarGroups = [];
  for (const g of wireGroups) {
    const items = [];
    for (const it of Array.isArray(g?.items) ? g.items : []) {
      if (!it || typeof it !== "object") continue;
      if (it.correctionId === null || it.correctionId === undefined) {
        const derived = deriveGrammarItem(it);
        if (derived) items.push(derived);
        continue;
      }
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
        derived: false,
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
      return { id: `g-${cid}`, said: raw.said, fix: raw.fix, why: cleanCorrectionText(raw.why) ?? "", lessonId: raw.lessonId, correctionId: cid, derived: false };
    });
    grammarGroups.push({ pattern: "Other fixes", rule: null, items });
  }

  // ── review · level · plan (RULES 9–11) — optional blocks, omitted when unusable ──
  const composeCtx = { guard, corpusFor, byLesson, logReject };
  const review = composeReview(wire.review, composeCtx);
  const level = composeLevel(wire.level, composeCtx);
  const plan = composePlan(wire.plan, window, composeCtx);

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
  // renderedGrammar = EVERY grammar row (anchored + derived) — what the section lists;
  // anchoredGrammar = rows with a Cambly correctionId — the only ones inside Σ.
  const renderedGrammar = grammarGroups.reduce((n, g) => n + g.items.length, 0);
  const anchoredGrammar = grammarGroups.reduce(
    (n, g) => n + g.items.filter((it) => it.correctionId !== null && it.correctionId !== undefined).length,
    0,
  );
  const derivedGrammar = renderedGrammar - anchoredGrammar;
  const renderedVocab = vocabulary.filter((v) => v.fromCorrectionId != null).length;
  const renderedPhrasing = phrasing.filter((p) => p.fromCorrectionId != null).length;
  const reportedCorrections = rawSigmaSet.size;
  const rejectedCount = rejects.filter((r) => r.dropped).length;

  const sigmaSum = anchoredGrammar + renderedVocab + renderedPhrasing;
  if (sigmaSum !== reportedCorrections) {
    throw new BuildIntegrityError(
      `Σ-invariant failed: reported ${reportedCorrections} !== anchored grammar ${anchoredGrammar} + vocab ${renderedVocab} + phrasing ${renderedPhrasing}`,
    );
  }

  const stats = {
    classes: lessons.length,
    // Summed from the lessons (not the rendered cards) so minutes can never drift
    // from classes when a wire class is omitted or duplicated (§10, builder-derived).
    minutes: lessons.reduce((n, l) => n + intOr0(l.minutes), 0),
    // User-facing count == what the Grammar section lists (beta finding 4) — anchored AND
    // derived rows — so the header stat, the index "N fixes" badge, and the section total
    // agree. The raw Cambly-reported Σ-set size stays in integrity.reportedCorrections.
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
    // Optional v2 blocks — present only when the wire supplied a usable one, so an older
    // wire (and every older VM on disk) keeps exactly the legacy key set.
    ...(review !== undefined ? { review } : {}),
    ...(level !== undefined ? { level } : {}),
    ...(plan !== undefined ? { plan } : {}),
    integrity: {
      reportedCorrections,
      renderedGrammar,
      derivedGrammar,
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

  const bundle = buildWeekBundle(lessons, { weekLabel: window?.weekLabel });
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
