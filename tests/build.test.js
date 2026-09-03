// tests/build.test.js — the two integrity gates + WeekVM assembly + generation loop
// (TECH §9 U-QG ①–⑩, U-SG ①–⑦, §10 contract, I-SM ②④⑤).

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { weekWindow } from "../src/week.js";
import { normalizeLessonDir } from "../src/normalize.js";
import { validateWeek, assertSigma } from "../src/render/validate.js";
import {
  recentFixturesSkip,
  presentRecentLessonDirs,
  REAL_STUDENT_UID,
} from "./fixtures-real.js";
import {
  normalizeQuote,
  quoteCorpus,
  quoteMatches,
  buildWeekVM,
  buildEmptyWeekVM,
  generateWeekVM,
  humanizePattern,
  stripWorksheet,
  stripWorksheetStrict,
  isGenericTopic,
  nextWeekLabel,
  quoteContainsTerm,
  SummarizeQualityError,
  REPROMPT_THRESHOLD,
  DERIVED_GRAMMAR_MAX,
  DERIVED_SAID_MAX_WORDS,
} from "../src/build.js";
import { coachNotes, BANDS, LEVEL_DIMENSIONS } from "../src/coach.js";

const FAST = { sleep: async () => {}, backoff: [0, 0, 0] };
const NOW = Date.parse("2026-05-18T09:00:00+08:00");
const WIN = weekWindow(Date.parse("2026-05-13T10:30:00+08:00")); // weekId 2026-05-11

/** Build a normalized lesson with sensible defaults; override any field. */
function mkLesson(over = {}) {
  return {
    lessonId: "L1",
    weekId: "2026-05-11",
    startAtCST: "2026-05-13T10:30:00+08:00",
    weekday: "Wed",
    minutes: 30,
    tutor: "Sam Rivers",
    topic: "Weekend",
    stats: { wpm: 68, talkRatio: 47, uniqueWords: 132 },
    transcript: [],
    corrections: [],
    tutorNotes: [],
    chat: [],
    ...over,
  };
}

/** A schema-shaped wire skeleton; override any array. */
function mkWire(over = {}) {
  return { classes: [], vocabulary: [], grammarGroups: [], phrasing: [], practice: [], ...over };
}

// ── normalizeQuote ─────────────────────────────────────────────────────────────

test("normalizeQuote applies NFKC + curly→straight + whitespace collapse, preserving case", () => {
  assert.equal(normalizeQuote("I can’t go"), "I can't go"); // curly apostrophe → straight
  assert.equal(normalizeQuote("she said “hi”"), 'she said "hi"'); // curly quotes → straight
  assert.equal(normalizeQuote("a  b\n\tc"), "a b c"); // whitespace runs collapse
  assert.equal(normalizeQuote("Hello ！"), "Hello !"); // full-width NFKC
  assert.notEqual(normalizeQuote("We Went"), normalizeQuote("we went")); // case preserved
});

// ── quoteCorpus / quoteMatches — U-QG ──────────────────────────────────────────

const corpusLesson = mkLesson({
  transcript: [
    { text: "I really like coffee.", speaker: "student" },
    { text: "You should say we hiked.", speaker: "tutor" },
    { text: "I went", speaker: "student" },
    { text: "to school", speaker: "student" },
  ],
  chat: [{ text: "hiked (past tense)", from: "tutor" }],
  tutorNotes: ["Great energy today!"],
});

test("quoteCorpus holds only transcript/segments + chat + tutor notes — never the Cambly coach notes the bundle prints", () => {
  const coach = "Reading aloud was the focus this lesson, and the article came through with real fluency and confidence.";
  const l = mkLesson({
    transcript: [{ text: "I read the article.", speaker: "student" }],
    aiTutorFeedback: { finalAIFeedback: { whatYouDidWell: coach, whatWeCanWorkOn: "Articles.", ideasForPractice: "Retell it." }, finalSuggestedNextLesson: "Small talk" },
  });
  const corpus = quoteCorpus(l);
  assert.deepEqual(corpus.any, ["I read the article."]);
  assert.equal(quoteMatches(coach, corpus, "any"), false, "a coach-line quote is a guard miss (nulled), by design");
  assert.equal(quoteMatches("Small talk", corpus, "tutor"), false);
});

test("U-QG① an exact substring on the right side is accepted", () => {
  assert.equal(quoteMatches("like coffee", quoteCorpus(corpusLesson), "student"), true);
});

test("U-QG② curly quotes/apostrophes normalize to straight and match", () => {
  const l = mkLesson({ transcript: [{ text: "I can't do it", speaker: "student" }] });
  assert.equal(quoteMatches("I can’t do it", quoteCorpus(l), "student"), true);
});

test("U-QG③ full-width NFKC punctuation matches its ASCII form", () => {
  const l = mkLesson({ transcript: [{ text: "谈论你的工作 ！", speaker: "student" }] });
  assert.equal(quoteMatches("谈论你的工作 !", quoteCorpus(l), "student"), true);
});

test("U-QG④ collapsed whitespace and newlines still match", () => {
  const l = mkLesson({ transcript: [{ text: "I  went\n there  today", speaker: "student" }] });
  assert.equal(quoteMatches("I went there today", quoteCorpus(l), "student"), true);
});

test("U-QG⑤ a case-only difference is ACCEPTED by the guard (normalizeQuote itself stays case-preserving)", () => {
  // The LLM capitalises the first word of a mid-sentence span; that is not a real mismatch.
  assert.equal(quoteMatches("I Really Like Coffee.", quoteCorpus(corpusLesson), "student"), true);
  assert.equal(quoteMatches("like coffee", quoteCorpus(corpusLesson), "student"), true);
  const mid = mkLesson({ transcript: [{ text: "so I think if I have two choice, I choose the second", speaker: "student" }] });
  assert.equal(quoteMatches("If I have two choice", quoteCorpus(mid), "student"), true);
  // …but a wording difference still is.
  assert.equal(quoteMatches("I really love coffee.", quoteCorpus(corpusLesson), "student"), false);
});

test("quoteCorpus is segments-first: a quote spanning two raw fragments matches once the normalizer merged them", () => {
  const raw = mkLesson({
    transcript: [{ text: "I went", speaker: "student" }, { text: "to school", speaker: "student" }],
  });
  assert.equal(quoteMatches("I went to school", quoteCorpus(raw), "student"), false); // fragments only (U-QG⑧)
  const merged = mkLesson({
    transcript: raw.transcript,
    segments: [{ speaker: "student", text: "I went to school", ts: 0, n: 2 }],
  });
  assert.equal(quoteMatches("I went to school", quoteCorpus(merged), "student"), true);
  // chat + tutor notes still join the corpus alongside the segments
  const withChat = mkLesson({ segments: [{ speaker: "student", text: "hello", ts: 0, n: 1 }], chat: [{ text: "hiked (past tense)", from: "tutor" }], tutorNotes: ["Great energy today!"] });
  assert.equal(quoteMatches("hiked (past tense)", quoteCorpus(withChat), "tutor"), true);
  assert.equal(quoteMatches("Great energy", quoteCorpus(withChat), "tutor"), true);
  // an empty segments array falls back to the raw transcript
  const emptySeg = mkLesson({ transcript: [{ text: "fallback line", speaker: "student" }], segments: [] });
  assert.equal(quoteMatches("fallback line", quoteCorpus(emptySeg), "student"), true);
});

test("U-QG⑥ a paraphrase is rejected and the reject entry carries type + quote + reason", () => {
  const wire = mkWire({
    vocabulary: [{ term: "coffee", meaning: "drink", quote: "I adore espresso", quoteBy: "student", lessonId: "L1", fromCorrectionId: null }],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [corpusLesson], wire, now: NOW });
  assert.equal(weekVM.vocabulary.length, 0);
  const r = weekVM.build.rejects.find((x) => x.type === "quote-guard");
  assert.ok(r);
  assert.equal(r.quote, "I adore espresso");
  assert.equal(r.section, "vocabulary");
  assert.match(r.reason, /verbatim/);
  assert.equal(weekVM.integrity.rejectedCount, 1);
});

test("U-QG⑦ quoteBy side check: a tutor-only line quoted as student is rejected", () => {
  // "You should say we hiked." is a tutor line.
  assert.equal(quoteMatches("we hiked", quoteCorpus(corpusLesson), "tutor"), true);
  assert.equal(quoteMatches("we hiked", quoteCorpus(corpusLesson), "student"), false);
});

test("U-QG⑧ a quote spanning two turns is rejected (matching is per line)", () => {
  // "I went" and "to school" are separate turns.
  assert.equal(quoteMatches("I went to school", quoteCorpus(corpusLesson), "student"), false);
  assert.equal(quoteMatches("I went", quoteCorpus(corpusLesson), "student"), true);
});

test("U-QG⑨ an empty or whitespace-only quote is rejected", () => {
  assert.equal(quoteMatches("", quoteCorpus(corpusLesson), "student"), false);
  assert.equal(quoteMatches("   \n ", quoteCorpus(corpusLesson), "student"), false);
});

test("U-QG⑩ practice lineage: a surviving id is kept, a rejected/unknown id is dropped + logged", () => {
  const lesson = mkLesson({
    transcript: [{ text: "I really like coffee.", speaker: "student" }],
    corrections: [{ id: "c1", said: "I likes coffee", fix: "I like coffee", why: "agreement" }],
  });
  const wire = mkWire({
    vocabulary: [{ term: "coffee", meaning: "drink", quote: "like coffee", quoteBy: "student", lessonId: "L1", fromCorrectionId: null }],
    grammarGroups: [{ pattern: "Agreement", rule: "match subject and verb", items: [{ correctionId: "c1", why: "s" }] }],
    practice: [
      { format: "CORRECT_IT", prompt: "I ____ coffee.", cue: null, answer: "**like**", why: "x", sourceIds: ["c1"] }, // raw correction id → kept
      { format: "SAY_IT_BETTER", prompt: "say it", cue: null, answer: "**better**", why: "y", sourceIds: ["v-1"] }, // surviving vocab id → kept
      { format: "FILL_THE_GAP", prompt: "____", cue: null, answer: "**z**", why: "z", sourceIds: ["nope-999"] }, // unknown → dropped
    ],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  assert.equal(weekVM.practice.length, 2);
  assert.deepEqual(weekVM.practice.map((p) => p.id), ["pr-1", "pr-2"]);
  assert.equal(weekVM.practice[0].lessonId, "L1"); // resolved from sourceIds[0]
  assert.ok(weekVM.build.rejects.some((r) => r.type === "lineage" && r.dropped));
});

// ── Σ-invariant — U-SG ──────────────────────────────────────────────────────────

const twoCorrections = [
  { id: "c1", said: "I go home", fix: "I went home", why: "past" },
  { id: "c2", said: "she have", fix: "she has", why: "agreement" },
];

test("U-SG① every raw id placed once passes with exact integrity arithmetic", () => {
  const lesson = mkLesson({ corrections: twoCorrections });
  const wire = mkWire({
    grammarGroups: [{ pattern: "Verb forms", rule: "use correct verb forms", items: [{ correctionId: "c1", why: "a" }, { correctionId: "c2", why: "b" }] }],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  assert.equal(weekVM.integrity.reportedCorrections, 2);
  assert.equal(weekVM.integrity.renderedGrammar, 2);
  assert.equal(weekVM.integrity.renderedVocab + weekVM.integrity.renderedPhrasing, 0);
  assert.equal(weekVM.grammarGroups.length, 1); // no Other-fixes group needed
});

test("U-SG② a missing id is self-healed into an Other fixes group from the raw record", () => {
  const lesson = mkLesson({ corrections: twoCorrections });
  const wire = mkWire({
    grammarGroups: [{ pattern: "Verb forms", rule: "r", items: [{ correctionId: "c1", why: "a" }] }],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  const other = weekVM.grammarGroups.find((g) => g.pattern === "Other fixes");
  assert.ok(other);
  assert.equal(other.rule, null); // renderer omits the rule line
  assert.equal(other.items[0].correctionId, "c2");
  assert.equal(other.items[0].said, "she have"); // straight from the raw record
  assert.equal(other.items[0].fix, "she has");
  assert.ok(weekVM.build.rejects.some((r) => r.type === "self-heal" && r.correctionId === "c2"));
  assert.equal(weekVM.integrity.renderedGrammar, 2);
});

test("U-SG③ a duplicate placement keeps the first and strips + logs the second", () => {
  const lesson = mkLesson({ corrections: twoCorrections });
  const wire = mkWire({
    grammarGroups: [
      { pattern: "A", rule: "r", items: [{ correctionId: "c1", why: "first" }] },
      { pattern: "B", rule: "r", items: [{ correctionId: "c1", why: "dup" }, { correctionId: "c2", why: "b" }] },
    ],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  const allItems = weekVM.grammarGroups.flatMap((g) => g.items);
  assert.equal(allItems.filter((i) => i.correctionId === "c1").length, 1); // first wins
  assert.equal(allItems.find((i) => i.correctionId === "c1").why, "first");
  assert.ok(weekVM.build.rejects.some((r) => r.type === "duplicate-correction" && r.correctionId === "c1"));
  assert.equal(weekVM.integrity.renderedGrammar, 2); // c1 + c2, no double count
});

test("U-SG④ an LLM-invented correctionId not in the raw set is dropped + logged", () => {
  const lesson = mkLesson({ corrections: [twoCorrections[0]] }); // only c1 exists
  const wire = mkWire({
    grammarGroups: [{ pattern: "A", rule: "r", items: [{ correctionId: "c1", why: "a" }, { correctionId: "ghost", why: "invented" }] }],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  const allItems = weekVM.grammarGroups.flatMap((g) => g.items);
  assert.ok(!allItems.some((i) => i.correctionId === "ghost"));
  assert.ok(weekVM.build.rejects.some((r) => r.type === "unknown-correction" && r.correctionId === "ghost"));
  assert.equal(weekVM.integrity.reportedCorrections, 1);
  assert.equal(weekVM.integrity.renderedGrammar, 1);
});

test("U-SG⑤ a null fromCorrectionId never counts toward Σ", () => {
  const lesson = mkLesson({
    transcript: [{ text: "we had a picnic", speaker: "student" }],
    corrections: [twoCorrections[0]],
  });
  const wire = mkWire({
    vocabulary: [{ term: "picnic", meaning: "meal", quote: "we had a picnic", quoteBy: "student", lessonId: "L1", fromCorrectionId: null }],
    grammarGroups: [{ pattern: "A", rule: "r", items: [{ correctionId: "c1", why: "a" }] }],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  assert.equal(weekVM.integrity.renderedVocab, 0); // null fromCorrectionId
  assert.equal(weekVM.vocabulary.length, 1); // still rendered
  assert.equal(weekVM.integrity.reportedCorrections, 1);
  assert.equal(weekVM.integrity.renderedGrammar, 1);
});

test("U-SG⑥ post-heal re-check: reported === grammar + vocab + phrasing (non-null only)", () => {
  const lesson = mkLesson({
    transcript: [{ text: "we had a picnic", speaker: "student" }, { text: "I go home", speaker: "student" }],
    corrections: [
      { id: "c1", said: "I go home", fix: "I went home", why: "past" },
      { id: "c2", said: "a picnic", fix: "a picnic", why: "vocab" },
      { id: "c3", said: "she have", fix: "she has", why: "agreement" },
    ],
  });
  const wire = mkWire({
    vocabulary: [{ term: "picnic", meaning: "meal", quote: "we had a picnic", quoteBy: "student", lessonId: "L1", fromCorrectionId: "c2" }],
    grammarGroups: [{ pattern: "A", rule: "r", items: [{ correctionId: "c1", why: "a" }] }],
    // c3 is unplaced → must self-heal
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  const { reportedCorrections, renderedGrammar, renderedVocab, renderedPhrasing } = weekVM.integrity;
  assert.equal(reportedCorrections, 3);
  assert.equal(renderedGrammar + renderedVocab + renderedPhrasing, 3);
  assert.equal(renderedVocab, 1); // c2 via vocab
  assert.equal(renderedGrammar, 2); // c1 explicit + c3 self-healed
});

test("U-SG⑦ a zero-correction week holds the invariant trivially with no forced section", () => {
  const lesson = mkLesson({ corrections: [] });
  const wire = mkWire();
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  assert.equal(weekVM.integrity.reportedCorrections, 0);
  assert.equal(weekVM.grammarGroups.length, 0);
  assert.equal(weekVM.stats.corrections, 0);
});

test("a vocab fromCorrectionId already claimed by grammar is nulled (first wins) but the item stays", () => {
  const lesson = mkLesson({
    transcript: [{ text: "we had a picnic", speaker: "student" }],
    corrections: [{ id: "c1", said: "a picnic", fix: "a picnic", why: "vocab" }],
  });
  const wire = mkWire({
    vocabulary: [{ term: "picnic", meaning: "meal", quote: "we had a picnic", quoteBy: "student", lessonId: "L1", fromCorrectionId: "c1" }],
    grammarGroups: [{ pattern: "A", rule: "r", items: [{ correctionId: "c1", why: "grammar first" }] }],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  assert.equal(weekVM.vocabulary.length, 1);
  assert.equal(weekVM.vocabulary[0].fromCorrectionId, null); // grammar claimed it first
  assert.equal(weekVM.integrity.renderedGrammar, 1);
  assert.equal(weekVM.integrity.renderedVocab, 0);
  assert.ok(weekVM.build.rejects.some((r) => r.type === "duplicate-correction" && r.section === "vocabulary" && !r.dropped));
});

test("a phrasing fromCorrectionId not in the raw set is nulled + logged, item retained", () => {
  const lesson = mkLesson({
    transcript: [{ text: "I go to work", speaker: "student" }],
    corrections: [],
  });
  const wire = mkWire({
    phrasing: [{ said: "I go to work", better: "I commute to work", why: "natural", lessonId: "L1", fromCorrectionId: "ghost" }],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  assert.equal(weekVM.phrasing.length, 1);
  assert.equal(weekVM.phrasing[0].fromCorrectionId, null);
  assert.ok(weekVM.build.rejects.some((r) => r.type === "unknown-correction" && r.section === "phrasing" && !r.dropped));
});

test("a practice item with an empty sourceIds array is dropped + logged", () => {
  const lesson = mkLesson({ corrections: [] });
  const wire = mkWire({
    practice: [{ format: "FILL_THE_GAP", prompt: "____", cue: null, answer: "**x**", why: "y", sourceIds: [] }],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  assert.equal(weekVM.practice.length, 0);
  assert.ok(weekVM.build.rejects.some((r) => r.type === "lineage" && r.dropped));
});

// ── WeekVM assembly — §10 contract & builder-derived scalars (I-SM ②) ──────────

test("I-SM② builder composes a full WeekVM; every scalar is builder-derived, not from the LLM", () => {
  const lesson = normalizeLessonDir("tests/fixtures/synthetic/lesson-basic", { uid: "student001" });
  const win = weekWindow(Date.parse(lesson.startAtCST));
  const wire = mkWire({
    classes: [{ lessonId: lesson.lessonId, moment: { text: "practising past tense", quotes: ["Okay, we hiked for three hours."] }, tutorNote: "keep it up" }],
    grammarGroups: [{ pattern: "Past tense", rule: "use past for finished actions", items: [
      { correctionId: "bbbb0000000000000000co01", why: "weekend over" },
      { correctionId: "bbbb0000000000000000co02", why: "past narration" },
    ] }],
  });
  const { weekVM } = buildWeekVM({ window: win, lessons: [lesson], wire, model: "gpt-5.1", promptTokens: 4321, now: NOW });

  // Top-level §10 shape.
  assert.deepEqual(Object.keys(weekVM).sort(), [
    "build", "classes", "endDate", "grammarGroups", "integrity", "isEmpty",
    "phrasing", "practice", "publishedAt", "schemaVersion", "startDate", "stats", "vocabulary", "weekId", "weekLabel",
  ].sort());
  assert.equal(weekVM.schemaVersion, 1);
  assert.equal(weekVM.isEmpty, false);
  assert.equal(weekVM.publishedAt, "2026-05-18T09:00:00+08:00"); // injected clock

  // Builder-derived scalars come from the normalized lesson, never the wire.
  const c = weekVM.classes[0];
  assert.equal(c.topic, "Weekend Plans");
  assert.equal(c.tutor, "Sam Rivers");
  assert.equal(c.minutes, 30);
  assert.deepEqual(c.stats, { wpm: 68, talkPct: 47, words: 132, fixes: 2 });
  assert.equal(c.startAt, "2026-05-13T10:30:00+08:00");

  assert.deepEqual(weekVM.stats, { classes: 1, minutes: 30, corrections: 2, expressions: 0 });
  assert.equal(weekVM.build.model, "gpt-5.1");
  assert.equal(weekVM.build.promptTokens, 4321);
});

test("I-SM⑤ one doctored bad quote → item absent from VM, in rejects, rejectedCount 1", () => {
  const lesson = mkLesson({ transcript: [{ text: "we had a picnic", speaker: "student" }], corrections: [] });
  const wire = mkWire({
    vocabulary: [{ term: "picnic", meaning: "meal", quote: "we DEVOURED a picnic", quoteBy: "student", lessonId: "L1", fromCorrectionId: null }],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  assert.equal(weekVM.vocabulary.length, 0);
  assert.equal(weekVM.integrity.rejectedCount, 1);
  assert.ok(weekVM.build.rejects.some((r) => r.quote === "we DEVOURED a picnic"));
});

test("a moment quote verbatim in the corpus but absent from moment.text is KEPT as a highlight (guarded against the corpus, NOT moment.text) — no reject spam", () => {
  const lesson = mkLesson({
    transcript: [{ text: "Okay, we hiked for three hours.", speaker: "student" }],
  });
  // The quote is verbatim in the transcript corpus but NOT a substring of moment.text —
  // the exact shape that used to dominate rejects and gut the moment highlight.
  const wire = mkWire({
    classes: [{ lessonId: "L1", moment: { text: "A calm reflective note on the weekend.", quotes: ["Okay, we hiked for three hours."] }, tutorNote: null }],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  assert.deepEqual(weekVM.classes[0].moment.quotes, ["Okay, we hiked for three hours."]); // kept — corpus-verbatim
  assert.equal(weekVM.build.rejects.filter((r) => r.section === "moment").length, 0); // no reject storm
  // The composed VM still passes the (relaxed) renderer gate.
  assert.doesNotThrow(() => validateWeek(weekVM));
});

test("a moment quote NOT verbatim in the corpus is still dropped + logged (the corpus guard still applies to moments)", () => {
  const lesson = mkLesson({
    transcript: [{ text: "Okay, we hiked for three hours.", speaker: "student" }],
  });
  const wire = mkWire({
    classes: [{ lessonId: "L1", moment: { text: "We had a wonderful hike.", quotes: ["we FLEW to the summit"] }, tutorNote: null }],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  assert.deepEqual(weekVM.classes[0].moment.quotes, []); // corpus guard dropped the invented quote
  assert.ok(weekVM.build.rejects.some((r) => r.section === "moment" && r.type === "quote-guard" && r.dropped));
  assert.doesNotThrow(() => validateWeek(weekVM));
});

test("a moment quote that IS a substring of moment.text is kept, and the VM renders", () => {
  const lesson = mkLesson({
    transcript: [{ text: "Okay, we hiked for three hours.", speaker: "student" }],
  });
  const wire = mkWire({
    classes: [{ lessonId: "L1", moment: { text: "A strong moment: Okay, we hiked for three hours.", quotes: ["Okay, we hiked for three hours."] }, tutorNote: null }],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  assert.deepEqual(weekVM.classes[0].moment.quotes, ["Okay, we hiked for three hours."]);
  assert.doesNotThrow(() => validateWeek(weekVM));
});

test("classes are one card per lesson: an omitted wire class still yields a card, a duplicate wire class does not dupe, minutes sum from lessons", () => {
  const l1 = mkLesson({ lessonId: "A", startAtCST: "2026-05-13T09:00:00+08:00", minutes: 30, tutorNotes: ["Great energy today!"] });
  const l2 = mkLesson({ lessonId: "B", startAtCST: "2026-05-15T09:00:00+08:00", minutes: 25 });
  const wire = mkWire({
    classes: [
      { lessonId: "A", moment: { text: "first take", quotes: [] }, tutorNote: "Great energy today!" }, // verbatim tutor note → kept
      { lessonId: "A", moment: { text: "DUPLICATE", quotes: [] }, tutorNote: "dup" }, // duplicate id → ignored
      // B omitted from the wire entirely
    ],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [l1, l2], wire, now: NOW });
  assert.deepEqual(weekVM.classes.map((c) => c.lessonId), ["A", "B"]); // exactly one card each
  assert.equal(weekVM.classes[0].tutorNote, "Great energy today!"); // first wire entry wins, not the dup
  assert.equal(weekVM.classes[0].moment.text, "first take");
  assert.equal(weekVM.classes[1].moment, null); // B had no wire class → no moment highlight
  assert.equal(weekVM.stats.classes, 2);
  assert.equal(weekVM.stats.minutes, 55); // 30 + 25, summed from lessons — never drifts from classes
});

test("classes are ordered chronologically and stats.minutes is the class-minutes sum", () => {
  const l1 = mkLesson({ lessonId: "A", startAtCST: "2026-05-15T09:00:00+08:00", minutes: 20 });
  const l2 = mkLesson({ lessonId: "B", startAtCST: "2026-05-13T09:00:00+08:00", minutes: 45 });
  const wire = mkWire({
    classes: [
      { lessonId: "A", moment: { text: "", quotes: [] }, tutorNote: null },
      { lessonId: "B", moment: { text: "", quotes: [] }, tutorNote: null },
    ],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [l1, l2], wire, now: NOW });
  assert.deepEqual(weekVM.classes.map((c) => c.lessonId), ["B", "A"]); // 05-13 before 05-15
  assert.equal(weekVM.stats.minutes, 65);
  assert.equal(weekVM.stats.classes, 2);
});

// ── tutorFocus (§10 contract addition) — Cambly's own coaching text, verbatim ──

test("class.tutorFocus is lifted VERBATIM from the ai_tutor feedback (not quote-guarded); null when absent", () => {
  const withFocus = mkLesson({
    lessonId: "A",
    startAtCST: "2026-05-13T09:00:00+08:00",
    aiTutorFeedback: {
      finalAIFeedback: { whatYouDidWell: "Great idioms today.", whatWeCanWorkOn: "Watch your tenses." },
      tutorNotes: "You made class fly by!",
      tutorNotesTranslated: "你让课飞快！",
      finalSuggestedNextLesson: "Maintaining Past Tense While Narrating Work Stories",
    },
  });
  const noFocus = mkLesson({ lessonId: "B", startAtCST: "2026-05-15T09:00:00+08:00" }); // mkLesson sets no aiTutorFeedback
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [withFocus, noFocus], wire: mkWire(), now: NOW });
  const [a, b] = weekVM.classes;
  assert.deepEqual(a.tutorFocus, {
    aiFeedback: "Great idioms today.", // the whatYouDidWell coach-summary section, verbatim
    workOn: "Watch your tenses.", // the whatWeCanWorkOn section (strict worksheet strip)
    tutorNotes: "You made class fly by!",
    tutorNotesZh: "你让课飞快！",
    nextFocus: "Maintaining Past Tense While Narrating Work Stories",
  });
  assert.equal(b.tutorFocus, null); // no ai_tutor feedback → null (older data shape)
});

// ── v2: tutorFocus.workOn — the STRICT worksheet rule ─────────────────────────────

test("stripWorksheetStrict nulls a value whose FIRST content line is a worksheet boundary — soft (emoji title) or hard", () => {
  const worksheet = "💻☕ Tech & Daily Work Small Talk\n🌟 Useful Vocabulary & Phrases\nGlitch – a small technical problem";
  assert.equal(stripWorksheetStrict(worksheet), null); // emoji title first → whole thing is a worksheet
  assert.equal(stripWorksheet(worksheet), worksheet); // the lenient rule keeps it (finding 1 — praise field)
  assert.equal(stripWorksheetStrict("Exercise 1: Choose the Correct Verb\n→ ______"), null); // hard first
  assert.equal(stripWorksheetStrict("\n  \n🗣️ Exercise 2: What Would You Say?\n\nChoose one"), null); // blank lines before the boundary still count as first
  // Coaching prose before a worksheet is kept; clean prose is untouched; non-strings pass through.
  assert.equal(stripWorksheetStrict("Work on articles.\n\n🍽️ Food Verb Tense Exercise\n→ ______"), "Work on articles.");
  const prose = "One area to keep building is sentence structure and word order.";
  assert.equal(stripWorksheetStrict(prose), prose);
  assert.equal(stripWorksheetStrict(null), null);
  assert.equal(stripWorksheetStrict(undefined), undefined);
});

test("coachNotes shapes the four Cambly coach fields (lenient didWell, strict workOn/practiceIdeas, verbatim nextLesson)", () => {
  const notes = coachNotes({
    finalAIFeedback: {
      whatYouDidWell: "🎉 Great retention.",
      whatWeCanWorkOn: "💻☕ Tech & Daily Work Small Talk\nGlitch – a small problem",
      ideasForPractice: "Retell your day.\n\nExercise 1: Fix the Tense Mistakes\n→ ______",
    },
    tutorNotes: "x",
    tutorNotesTranslated: null,
    finalSuggestedNextLesson: "Articles in technical talk",
  });
  assert.deepEqual(notes, { didWell: "🎉 Great retention.", workOn: null, practiceIdeas: "Retell your day.", nextLesson: "Articles in technical talk" });
  // Plain-string finalAIFeedback (older shape) is the praise field; a null block yields four nulls.
  assert.equal(coachNotes({ finalAIFeedback: "Solid class." }).didWell, "Solid class.");
  assert.deepEqual(coachNotes(null), { didWell: null, workOn: null, practiceIdeas: null, nextLesson: null });
  assert.deepEqual(coachNotes({ finalAIFeedback: { whatWeCanWorkOn: "   " } }).workOn, null);
});

test("tutorFocus.workOn is Cambly's whatWeCanWorkOn under the STRICT rule: prose kept, pasted worksheet → null, tail cut", () => {
  const build = (workOn) => {
    const l = mkLesson({ aiTutorFeedback: { finalAIFeedback: { whatYouDidWell: "Good.", whatWeCanWorkOn: workOn }, tutorNotes: null, tutorNotesTranslated: null, finalSuggestedNextLesson: null } });
    return buildWeekVM({ window: WIN, lessons: [l], wire: mkWire(), now: NOW }).weekVM.classes[0].tutorFocus.workOn;
  };
  assert.equal(build("Choosing between near-synonyms is worth focused attention."), "Choosing between near-synonyms is worth focused attention.");
  assert.equal(build("💻☕ Tech & Daily Work Small Talk\n🌟 Useful Vocabulary\nGlitch – a small technical problem"), null);
  assert.equal(build("Watch your articles.\n\n✏️ Exercise 1: Choose the Correct Verb\nYesterday I (go / went) home."), "Watch your articles.");
  assert.equal(build(undefined), null);
  // A lesson with no ai_tutor block has no tutorFocus at all (unchanged).
  assert.equal(buildWeekVM({ window: WIN, lessons: [mkLesson()], wire: mkWire(), now: NOW }).weekVM.classes[0].tutorFocus, null);
});

// ── v2: classes[].title — the LLM title only stands in for a generic topic ─────────

test("isGenericTopic recognises Cambly's generic lesson-plan titles (case/space-insensitive) and blanks", () => {
  for (const t of [null, undefined, "", "  ", "Pro Lesson", "pro lesson", "PRO  LESSON", "Kickoff Conversation", "Conversation"]) {
    assert.equal(isGenericTopic(t), true, JSON.stringify(t));
  }
  for (const t of ["Weekend Plans", "Lunch breaks & indoor workdays", "Getting to know you", "Pro Lesson: Remote work"]) {
    assert.equal(isGenericTopic(t), false, t);
  }
});

test("classes[].title is set ONLY for a generic topic, and never to another generic/blank/over-long title", () => {
  const cls = (topic, title) => {
    const l = mkLesson({ topic });
    const wire = mkWire({ classes: [{ lessonId: "L1", title, moment: { text: "m", quotes: [] }, tutorNote: null }] });
    return buildWeekVM({ window: WIN, lessons: [l], wire, now: NOW }).weekVM.classes[0];
  };
  assert.equal(cls("Pro Lesson", "Lunch breaks & indoor workdays").title, "Lunch breaks & indoor workdays");
  assert.equal(cls("Pro Lesson", "Lunch breaks & indoor workdays").topic, "Pro Lesson", "the topic is kept verbatim on the VM");
  assert.equal(cls(null, "  Coffee habits at work  ").title, "Coffee habits at work"); // trimmed
  assert.equal(cls("Weekend Plans", "Lunch breaks & indoor workdays").title, null); // a specific topic wins
  assert.equal(cls("Pro Lesson", "Pro Lesson").title, null); // RULE 12 violated → dropped
  assert.equal(cls("Pro Lesson", "").title, null);
  assert.equal(cls("Pro Lesson", "one two three four five six seven eight nine ten eleven twelve thirteen").title, null); // over-long
  // A wire without a class entry (or a legacy wire without `title`) yields null.
  const noWire = buildWeekVM({ window: WIN, lessons: [mkLesson({ topic: "Pro Lesson" })], wire: mkWire(), now: NOW }).weekVM.classes[0];
  assert.equal(noWire.title, null);
});

test("tutorFocus passes a plain-string finalAIFeedback straight through as aiFeedback", () => {
  const l = mkLesson({ aiTutorFeedback: { finalAIFeedback: "Solid class overall.", tutorNotes: null, tutorNotesTranslated: null, finalSuggestedNextLesson: null } });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [l], wire: mkWire(), now: NOW });
  assert.equal(weekVM.classes[0].tutorFocus.aiFeedback, "Solid class overall.");
  assert.equal(weekVM.classes[0].tutorFocus.nextFocus, null);
});

test("tutorFocus aiFeedback is null (not a criticism section) when finalAIFeedback lacks whatYouDidWell", () => {
  // Only a "work on" section present — surfacing it under the positive coach-summary slot
  // would be a semantic mismatch, so aiFeedback stays null (summary-key allowlist).
  const l = mkLesson({
    aiTutorFeedback: {
      finalAIFeedback: { whatWeCanWorkOn: "Watch your tenses.", ideasForPractice: "Retell a story." },
      tutorNotes: "Nice energy today.",
      tutorNotesTranslated: null,
      finalSuggestedNextLesson: null,
    },
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [l], wire: mkWire(), now: NOW });
  assert.equal(weekVM.classes[0].tutorFocus.aiFeedback, null);
  assert.equal(weekVM.classes[0].tutorFocus.tutorNotes, "Nice energy today.");
});

// ── older-shape week: structured grammar + Σ intact must be UNCHANGED ──────────

test("older-shape week (real corrective corrections) still yields structured grammar with Σ intact + a verbatim tutorFocus", () => {
  const lesson = normalizeLessonDir("tests/fixtures/synthetic/lesson-basic", { uid: "student001" });
  const win = weekWindow(Date.parse(lesson.startAtCST));
  const wire = mkWire({
    grammarGroups: [{ pattern: "Past tense", rule: "use past for finished actions", items: [
      { correctionId: "bbbb0000000000000000co01", why: "weekend over" },
      { correctionId: "bbbb0000000000000000co02", why: "past narration" },
    ] }],
  });
  const { weekVM } = buildWeekVM({ window: win, lessons: [lesson], wire, now: NOW });
  // Structured grammar preserved exactly as before (the older corrective-feedback path).
  assert.equal(weekVM.grammarGroups.length, 1);
  assert.equal(weekVM.grammarGroups[0].pattern, "Past tense");
  assert.equal(weekVM.grammarGroups[0].items.length, 2);
  assert.equal(weekVM.grammarGroups[0].items[0].said, "I go to the mountain with my family."); // filled from the raw record
  // Σ intact.
  assert.equal(weekVM.integrity.reportedCorrections, 2);
  assert.equal(weekVM.integrity.renderedGrammar, 2);
  assert.equal(weekVM.stats.corrections, 2);
  assert.ok(weekVM.stats.minutes > 0);
  // tutorFocus present (synthetic carries only tutorNotes → the other coaching fields are null).
  const tf = weekVM.classes[0].tutorFocus;
  assert.ok(tf);
  assert.match(tf.tutorNotes, /past-tense/);
  assert.equal(tf.aiFeedback, null);
  assert.equal(tf.nextFocus, null);
  assert.equal(tf.tutorNotesZh, null);
  assert.doesNotThrow(() => validateWeek(weekVM));
});

test("buildEmptyWeekVM is an isEmpty:true stub of the same §10 shape with all arrays empty", () => {
  const vm = buildEmptyWeekVM({ window: WIN, model: "gpt-5.1", now: NOW });
  assert.equal(vm.isEmpty, true);
  assert.equal(vm.schemaVersion, 1);
  assert.deepEqual(vm.stats, { classes: 0, minutes: 0, corrections: 0, expressions: 0 });
  for (const k of ["classes", "vocabulary", "grammarGroups", "phrasing", "practice"]) {
    assert.deepEqual(vm[k], []);
  }
  assert.deepEqual(vm.integrity, { reportedCorrections: 0, renderedGrammar: 0, renderedVocab: 0, renderedPhrasing: 0, rejectedCount: 0 });
  assert.equal(vm.weekId, WIN.weekId);
});

test("the builder is deterministic: identical inputs → byte-identical WeekVM", () => {
  const lesson = normalizeLessonDir("tests/fixtures/synthetic/lesson-basic", { uid: "student001" });
  const win = weekWindow(Date.parse(lesson.startAtCST));
  const wire = mkWire({
    classes: [{ lessonId: lesson.lessonId, moment: { text: "x", quotes: [] }, tutorNote: null }],
    grammarGroups: [{ pattern: "P", rule: "r", items: [{ correctionId: "bbbb0000000000000000co01", why: "a" }, { correctionId: "bbbb0000000000000000co02", why: "b" }] }],
  });
  const a = buildWeekVM({ window: win, lessons: [lesson], wire, model: "m", promptTokens: 1, now: NOW }).weekVM;
  const b = buildWeekVM({ window: win, lessons: [lesson], wire, model: "m", promptTokens: 1, now: NOW }).weekVM;
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// ── beta finding 1: worksheet/exercise tails stripped from the Focus box ───────

test("stripWorksheet truncates a coaching string at the first worksheet marker, keeping the prose", () => {
  const withTail = [
    'You picked up "cut down on" and used it right away — real retention.',
    "That kind of quick application is exactly what progress looks like.",
    "",
    "🍽️ Food-Focused Verb Tense Exercise",
    "✏️ Exercise 1: Choose the Correct Verb",
    "Yesterday, I (cook / cooked / will cook) pasta.",
    "→ ______",
  ].join("\n");
  const out = stripWorksheet(withTail);
  assert.match(out, /real retention/);
  assert.match(out, /exactly what progress looks like\.$/); // cut cleanly at the prose end
  assert.ok(!/exercise\s*1/i.test(out), "the drill tail is gone");
  assert.ok(!out.includes("🍽️"), "the emoji section header is gone");
});

test("stripWorksheet leaves clean multi-sentence coaching unchanged and passes non-strings through", () => {
  const clean =
    'Descriptive language was the heart of this lesson. "Baby blue" landed naturally and stuck.';
  assert.equal(stripWorksheet(clean), clean);
  assert.equal(stripWorksheet(null), null);
});

test("stripWorksheet keeps coaching that merely OPENS with an emoji or names 'exercise' mid-sentence (finding 1)", () => {
  // A decorative celebratory opener is not a worksheet boundary — the whole note survives.
  const emojiOpener = "🎉 Amazing progress this week! You nailed the past tense throughout.";
  assert.equal(stripWorksheet(emojiOpener), emojiOpener);
  // "exercise N" / "choose the correct" as ordinary words (not line-start drill headers) stay.
  const midSentence = "You did this breathing exercise 3 times and it helped your pace.";
  assert.equal(stripWorksheet(midSentence), midSentence);
  const choose = "Great work! Choose the correct path in life and keep going.";
  assert.equal(stripWorksheet(choose), choose);
  // A real emoji-led worksheet header IS still a boundary; the prose before it is kept.
  const withHeader = "Nice retention.\n🍽️ Food-Focused Verb Tense Exercise\n→ ______";
  assert.equal(stripWorksheet(withHeader), "Nice retention.");
});

test("stripWorksheet keeps enumerated coaching tips; a bare numbered list is not a drill (finding 2)", () => {
  const tips =
    "Two things to focus on next time:\n1. Past-tense endings when you speed up.\n2. Articles before nouns.";
  assert.equal(stripWorksheet(tips), tips);
  // A numbered line that carries slash options IS a drill item and cuts.
  const drill = "Try these:\n1. Yesterday I (go / went / gone) home.\n2. She (has / have) a cat.";
  assert.equal(stripWorksheet(drill), "Try these:");
});

test("tutorFocus strips a worksheet tail out of the ai coach summary; other fields intact (finding 1)", () => {
  const l = mkLesson({
    aiTutorFeedback: {
      finalAIFeedback: {
        whatYouDidWell:
          "Great phrasal verbs today.\n\nExercise 2: Fix the Tense Mistakes\nYesterday I cook dinner.\n→ ______",
      },
      tutorNotes: null,
      tutorNotesTranslated: null,
      finalSuggestedNextLesson: "Phrasal verbs in the past tense",
    },
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [l], wire: mkWire(), now: NOW });
  const tf = weekVM.classes[0].tutorFocus;
  assert.equal(tf.aiFeedback, "Great phrasal verbs today.");
  assert.equal(tf.nextFocus, "Phrasal verbs in the past tense");
});

// ── beta finding 2: the tutor sign-off shows once (highlight, not the Focus box) ──

test("the tutor's sign-off shows ONCE: with Cambly's tutorNotes in the Focus box the card tutorNote is dropped; a Focus line that duplicates the MOMENT is still stripped (finding 2)", () => {
  const signoff = "Thank you for visiting today! Looking forward to seeing you again soon";
  const l = mkLesson({
    aiTutorFeedback: {
      finalAIFeedback: null,
      tutorNotes: signoff,
      tutorNotesTranslated: null,
      finalSuggestedNextLesson: "Keep practising the past tense",
    },
  });
  const wire = mkWire({
    classes: [
      {
        lessonId: "L1",
        moment: { text: "A calm reflective close.", quotes: [] },
        tutorNote: `${signoff} 🎉`, // the LLM's copy of the same note
      },
    ],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [l], wire, now: NOW });
  const c = weekVM.classes[0];
  assert.equal(c.tutorNote, null); // the Focus box shows Cambly's own note verbatim → the card does not repeat it
  assert.equal(c.tutorFocus.tutorNotes, signoff); // verbatim, un-stripped
  assert.equal(c.tutorFocus.nextFocus, "Keep practising the past tense"); // other fields intact
  // The finding-2 dedupe against the class highlight still holds for the MOMENT text.
  const dup = buildWeekVM({
    window: WIN,
    lessons: [l],
    wire: mkWire({ classes: [{ lessonId: "L1", moment: { text: `${signoff} 🎉`, quotes: [] }, tutorNote: null }] }),
    now: NOW,
  }).weekVM.classes[0];
  assert.equal(dup.tutorFocus.tutorNotes, null); // stripped from the Focus box → shown once, in the moment
  assert.equal(dup.tutorNote, null);
});

test("a distinct Focus-box coaching line is NOT stripped when it does not duplicate the highlight (finding 2)", () => {
  const l = mkLesson({
    aiTutorFeedback: {
      finalAIFeedback: null,
      tutorNotes: "Keep an eye on irregular past verbs when you speed up.",
      tutorNotesTranslated: null,
      finalSuggestedNextLesson: null,
    },
  });
  const wire = mkWire({
    classes: [
      { lessonId: "L1", moment: { text: "A calm reflective close.", quotes: [] }, tutorNote: "What a lovely class today!" },
    ],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [l], wire, now: NOW });
  assert.equal(
    weekVM.classes[0].tutorFocus.tutorNotes,
    "Keep an eye on irregular past verbs when you speed up.",
  );
});

// ── beta finding 3: grammar habit labels are human-readable, never slugs or "." ──

test("humanizePattern repairs slug / punctuation labels and leaves good titles unchanged", () => {
  assert.equal(humanizePattern("/tense-with-past-time/"), "Tense with past time");
  assert.equal(humanizePattern("/ purpose / infinitives /"), "Purpose & infinitives");
  assert.equal(humanizePattern("tense-with-past-time"), "Tense with past time");
  assert.equal(humanizePattern("."), "Other fixes");
  assert.equal(humanizePattern(""), "Other fixes");
  // good, human titles pass through verbatim
  assert.equal(humanizePattern("Past tense"), "Past tense");
  assert.equal(humanizePattern("Subject-verb agreement"), "Subject-verb agreement");
  assert.equal(humanizePattern("must/try forms"), "must/try forms");
});

test("humanizePattern normalizes ALL-CAPS, camelCase and mixed-case slugs too (finding 6)", () => {
  assert.equal(humanizePattern("PAST-TENSE-ERRORS"), "Past tense errors");
  assert.equal(humanizePattern("pastTense"), "Past tense");
  assert.equal(humanizePattern("past-Tense"), "Past tense");
  assert.equal(humanizePattern("subject_verb_agreement"), "Subject verb agreement");
});

test("the builder humanizes a slug grammar-group pattern before it renders (finding 3)", () => {
  const lesson = mkLesson({ corrections: [{ id: "c1", said: "I go", fix: "I went", why: "past" }] });
  const wire = mkWire({
    grammarGroups: [{ pattern: "/tense-with-past-time/", rule: "past for finished actions", items: [{ correctionId: "c1", why: "over" }] }],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  assert.equal(weekVM.grammarGroups[0].pattern, "Tense with past time");
  assert.doesNotThrow(() => validateWeek(weekVM));
});

// ── beta finding 4: stats.corrections == the Grammar-section total (renderedGrammar) ──

test("stats.corrections shows the rendered grammar count, not the raw Σ anchor (finding 4)", () => {
  const lesson = mkLesson({
    transcript: [{ text: "we had a picnic", speaker: "student" }],
    corrections: [
      { id: "c1", said: "I go home", fix: "I went home", why: "past" },
      { id: "c2", said: "a picnic", fix: "a picnic", why: "vocab" },
      { id: "c3", said: "she have", fix: "she has", why: "agreement" },
    ],
  });
  const wire = mkWire({
    vocabulary: [{ term: "picnic", meaning: "meal", quote: "we had a picnic", quoteBy: "student", lessonId: "L1", fromCorrectionId: "c2" }],
    grammarGroups: [{ pattern: "Past tense", rule: "r", items: [{ correctionId: "c1", why: "a" }] }],
    // c3 unplaced → self-healed into grammar
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  // reported (raw) = 3; only 2 render as grammar (c1 explicit + c3 self-healed), c2 is vocab.
  assert.equal(weekVM.integrity.reportedCorrections, 3);
  assert.equal(weekVM.integrity.renderedGrammar, 2);
  assert.equal(weekVM.stats.corrections, 2); // user-facing == grammar section, NOT the raw 3
  assert.doesNotThrow(() => assertSigma(weekVM)); // header == section under the Σ gate
});

// ── beta finding 5: the vocab example must actually contain the term ───────────

test("quoteContainsTerm is case-insensitive and normalizes curly punctuation", () => {
  assert.equal(quoteContainsTerm("I love Binge Watching on weekends", "binge watching"), true);
  assert.equal(quoteContainsTerm("could you explain what that word means?", "tech savvy"), false);
  assert.equal(quoteContainsTerm("we can’t stop", "can't"), true); // curly → straight
});

test("quoteContainsTerm accepts a real usage in a different inflection / hyphenation (finding 3)", () => {
  assert.equal(quoteContainsTerm("I binge watched three shows all weekend", "binge watching"), true); // -ed ~ -ing
  assert.equal(quoteContainsTerm("we were running late for the bus", "run late"), true); // running ~ run
  assert.equal(quoteContainsTerm("my well being matters", "well-being"), true); // hyphen folds to space
  assert.equal(quoteContainsTerm("I watched the movies", "movie"), true); // plural ~ singular
  // still rejects a line that does not actually use the term in any form
  assert.equal(quoteContainsTerm("could you explain what that word means?", "tech savvy"), false);
});

test("a verbatim vocab quote that lacks the term drops the example but keeps the word (finding 5)", () => {
  const lesson = mkLesson({
    transcript: [{ text: "could you explain what that word means?", speaker: "student" }], // a real line, not the term
  });
  const wire = mkWire({
    vocabulary: [{ term: "tech savvy", meaning: "good with technology", quote: "could you explain what that word means?", quoteBy: "student", lessonId: "L1", fromCorrectionId: null }],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  assert.equal(weekVM.vocabulary.length, 1); // the word is kept
  assert.equal(weekVM.vocabulary[0].term, "tech savvy");
  assert.equal(weekVM.vocabulary[0].quote, null); // the misleading example is dropped
  assert.equal(weekVM.vocabulary[0].quoteBy, null);
  assert.ok(weekVM.build.rejects.some((r) => r.type === "vocab-example" && !r.dropped));
  assert.doesNotThrow(() => validateWeek(weekVM));
});

test("a verbatim vocab quote that contains the term keeps the example (finding 5)", () => {
  const lesson = mkLesson({
    transcript: [{ text: "I am not very tech savvy at all", speaker: "student" }],
  });
  const wire = mkWire({
    vocabulary: [{ term: "tech savvy", meaning: "good with technology", quote: "I am not very tech savvy at all", quoteBy: "student", lessonId: "L1", fromCorrectionId: null }],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  assert.equal(weekVM.vocabulary[0].quote, "I am not very tech savvy at all");
  assert.equal(weekVM.vocabulary[0].quoteBy, "student");
});

// ── beta finding 1: a JSON serialization artifact must not reach a grammar row ──

test("a grammar why carrying a JSON serialization artifact is stripped to clean text (finding 1)", () => {
  const lesson = mkLesson({
    corrections: [
      { id: "c1", said: "My last work is at a startup.", fix: "My last job was at a startup.", why: "'Work' is general.", category: "grammar" },
    ],
  });
  const wire = mkWire({
    grammarGroups: [
      {
        pattern: "Word choice",
        rule: "Pick the specific noun.",
        items: [{ correctionId: "c1", why: "'Job' names a specific role.\"}]},{\"correctionId\":\"c2\"" }],
      },
    ],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  const why = weekVM.grammarGroups[0].items[0].why;
  assert.equal(why, "'Job' names a specific role.");
  assert.doesNotMatch(why, /}\]},\{|":"|\[\{/); // no structural token survives
  assert.doesNotThrow(() => validateWeek(weekVM));
});

test("a self-healed grammar why with a JSON artifact is cleaned in Other fixes (finding 1)", () => {
  // A correction the wire never groups self-heals into "Other fixes" from raw.why.
  const lesson = mkLesson({
    corrections: [
      { id: "c9", said: "I saw it in TV.", fix: "I saw it on TV.", why: "Use 'on' for TV.}]},{\"x\":\"y\"", category: "grammar" },
    ],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire: mkWire(), now: NOW });
  const otherFixes = weekVM.grammarGroups.find((g) => g.pattern === "Other fixes");
  assert.ok(otherFixes);
  assert.equal(otherFixes.items[0].why, "Use 'on' for TV.");
  assert.doesNotThrow(() => validateWeek(weekVM));
});

// ── beta finding: a vocab example must be a clean short usage, or be omitted ─────

test("a run-on transcript blob is dropped as a vocab example, keeping the word", () => {
  const blob =
    "get together we meet up, reservation we book a table, appropriate is suitable, and again get together and reservation are useful phrases to know";
  const lesson = mkLesson({ transcript: [{ text: blob, speaker: "tutor" }] });
  const wire = mkWire({
    vocabulary: [{ term: "get together", meaning: "to meet up", quote: blob, quoteBy: "tutor", lessonId: "L1", fromCorrectionId: null }],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  assert.equal(weekVM.vocabulary.length, 1);
  assert.equal(weekVM.vocabulary[0].term, "get together");
  assert.equal(weekVM.vocabulary[0].quote, null); // the run-on blob is not shown
  assert.doesNotThrow(() => validateWeek(weekVM));
});

test("an identical example on two vocab cards is dropped from BOTH (no duplicate examples)", () => {
  const line = "Let's get together this weekend for coffee.";
  const lesson = mkLesson({ transcript: [{ text: line, speaker: "student" }] });
  const wire = mkWire({
    vocabulary: [
      { term: "get together", meaning: "to meet up", quote: line, quoteBy: "student", lessonId: "L1", fromCorrectionId: null },
      { term: "weekend", meaning: "Saturday and Sunday", quote: line, quoteBy: "student", lessonId: "L1", fromCorrectionId: null },
    ],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  assert.equal(weekVM.vocabulary.length, 2);
  assert.equal(weekVM.vocabulary[0].quote, null);
  assert.equal(weekVM.vocabulary[1].quote, null);
});

test("a vocab example that is a flagged error/corrected form is dropped (never resurface an error)", () => {
  const errSaid = "I'm a tech savvy, but I want to improve.";
  const lesson = mkLesson({
    transcript: [{ text: errSaid, speaker: "student" }],
    corrections: [{ id: "c1", said: errSaid, fix: "I'm tech savvy, but I want to improve.", why: "Drop the article before an adjective used alone.", category: "grammar" }],
  });
  const wire = mkWire({
    vocabulary: [{ term: "tech savvy", meaning: "good with technology", quote: errSaid, quoteBy: "student", lessonId: "L1", fromCorrectionId: null }],
    grammarGroups: [{ pattern: "Articles", rule: "No article before a lone adjective.", items: [{ correctionId: "c1", why: "'a' is not needed before 'tech savvy'." }] }],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  const tech = weekVM.vocabulary.find((v) => v.term === "tech savvy");
  assert.equal(tech.quote, null); // the corrected error never resurfaces as a usage example
  assert.doesNotThrow(() => validateWeek(weekVM));
});

test("a definition of the term is dropped, but a clean short unique usage is kept", () => {
  const defn = "Gossip means talking about other people's private lives.";
  const usage = "We should get together for dinner soon.";
  const lesson = mkLesson({
    transcript: [
      { text: defn, speaker: "tutor" },
      { text: usage, speaker: "student" },
    ],
  });
  const wire = mkWire({
    vocabulary: [
      { term: "gossip", meaning: "idle talk about others", quote: defn, quoteBy: "tutor", lessonId: "L1", fromCorrectionId: null },
      { term: "get together", meaning: "to meet up", quote: usage, quoteBy: "student", lessonId: "L1", fromCorrectionId: null },
    ],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  const gossip = weekVM.vocabulary.find((v) => v.term === "gossip");
  const meet = weekVM.vocabulary.find((v) => v.term === "get together");
  assert.equal(gossip.quote, null); // circular definition dropped
  assert.equal(meet.quote, usage); // clean usage kept
  assert.equal(meet.quoteBy, "student");
  assert.doesNotThrow(() => validateWeek(weekVM));
});

// ── v2: transcript-derived grammar items (RULE 6) — guard + ids + split Σ ─────────

const derivedLesson = () =>
  mkLesson({
    transcript: [
      { text: "so I think if I have two choice, I choose the second one", speaker: "student" },
      { text: "I go to office every day and I eat at desk", speaker: "student" },
      { text: "You should say two choices.", speaker: "tutor" },
    ],
  });

const derivedItem = (over = {}) => ({
  correctionId: null,
  said: "If I have two choice",
  fix: "If I have two choices",
  why: "'two' needs a plural noun",
  lessonId: "L1",
  ...over,
});

test("a derived grammar item whose said is a verbatim STUDENT span (case-insensitive) is kept as g-d1, derived:true, outside Σ", () => {
  const wire = mkWire({ grammarGroups: [{ pattern: "Plural -s", rule: "Two or more → plural noun.", items: [derivedItem()] }] });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [derivedLesson()], wire, now: NOW });
  assert.equal(weekVM.grammarGroups.length, 1);
  const it = weekVM.grammarGroups[0].items[0];
  assert.deepEqual(it, {
    id: "g-d1",
    said: "If I have two choice", // the LLM's own span, kept verbatim (capitalised first word tolerated)
    fix: "If I have two choices",
    why: "'two' needs a plural noun",
    lessonId: "L1",
    correctionId: null,
    derived: true,
  });
  // Σ: no Cambly records → reported 0 = anchored 0; the section (and the header stat) list 1 row.
  assert.equal(weekVM.integrity.reportedCorrections, 0);
  assert.equal(weekVM.integrity.renderedGrammar, 1);
  assert.equal(weekVM.integrity.derivedGrammar, 1);
  assert.equal(weekVM.stats.corrections, 1);
  assert.doesNotThrow(() => validateWeek(weekVM));
  assert.doesNotThrow(() => assertSigma(weekVM));
  assert.equal(weekVM.build.rejects.length, 0);
});

test("derived items mix with anchored ones: Σ counts only anchored, stats.corrections counts every row, ids stay distinct", () => {
  const lesson = derivedLesson();
  lesson.corrections = [{ id: "c1", said: "I eat at desk", fix: "I eat at my desk", why: "possessive" }];
  const wire = mkWire({
    grammarGroups: [
      { pattern: "Plural -s", rule: null, items: [derivedItem()] },
      { pattern: "Articles", rule: null, items: [{ correctionId: "c1", said: null, fix: null, why: "needs 'my'", lessonId: null }, derivedItem({ said: "I go to office", fix: "I go to the office", why: "article" })] },
    ],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  const items = weekVM.grammarGroups.flatMap((g) => g.items);
  assert.deepEqual(items.map((i) => i.id), ["g-d1", "g-c1", "g-d2"]);
  assert.deepEqual(items.map((i) => i.derived), [true, false, true]);
  assert.equal(items[1].said, "I eat at desk", "anchored said/fix come from the Cambly record, not the wire");
  assert.equal(weekVM.integrity.reportedCorrections, 1);
  assert.equal(weekVM.integrity.renderedGrammar, 3);
  assert.equal(weekVM.integrity.derivedGrammar, 2);
  assert.equal(weekVM.stats.corrections, 3);
  assert.doesNotThrow(() => assertSigma(weekVM));
  // A self-healed record also carries derived:false.
  const healed = buildWeekVM({ window: WIN, lessons: [lesson], wire: mkWire(), now: NOW }).weekVM;
  assert.equal(healed.grammarGroups[0].items[0].derived, false);
});

test("a derived item is dropped + logged when said is not a student line, is a tutor line, exceeds 25 words, equals its fix, or cites an unknown lesson", () => {
  const cases = [
    { it: derivedItem({ said: "if I have three choice" }), type: "quote-guard" }, // wording differs
    { it: derivedItem({ said: "You should say two choices.", fix: "You should say two choice." }), type: "quote-guard" }, // tutor line, student side
    { it: derivedItem({ said: Array.from({ length: DERIVED_SAID_MAX_WORDS + 1 }, (_, i) => `w${i}`).join(" ") }), type: "derived-grammar" },
    { it: derivedItem({ fix: "if I have two choice" }), type: "derived-grammar" }, // identical (case-insensitive)
    { it: derivedItem({ lessonId: "nope" }), type: "derived-grammar" },
    { it: derivedItem({ said: "" }), type: "derived-grammar" },
    { it: derivedItem({ fix: null }), type: "derived-grammar" },
  ];
  for (const { it, type } of cases) {
    const wire = mkWire({ grammarGroups: [{ pattern: "P", rule: null, items: [it] }] });
    const { weekVM } = buildWeekVM({ window: WIN, lessons: [derivedLesson()], wire, now: NOW });
    assert.equal(weekVM.grammarGroups.length, 0, `dropped: ${JSON.stringify(it)}`);
    assert.ok(weekVM.build.rejects.some((r) => r.type === type && r.dropped && r.section === "grammar"), `logged as ${type}: ${JSON.stringify(it)}`);
    assert.equal(weekVM.stats.corrections, 0);
  }
});

test("derived items are de-duplicated on said and capped at DERIVED_GRAMMAR_MAX; the guard ratio counts derived misses", () => {
  const lines = Array.from({ length: DERIVED_GRAMMAR_MAX + 2 }, (_, i) => ({ text: `I have ${i} apple in my bag`, speaker: "student" }));
  const lesson = mkLesson({ transcript: lines });
  const items = lines.map((l, i) => derivedItem({ said: l.text, fix: `I have ${i} apples in my bag` }));
  const wire = mkWire({ grammarGroups: [{ pattern: "Plural -s", rule: null, items: [...items, derivedItem({ said: "i have 0 apple in my bag", fix: "x" })] }] });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  assert.equal(weekVM.grammarGroups[0].items.length, DERIVED_GRAMMAR_MAX);
  assert.equal(weekVM.grammarGroups[0].items.at(-1).id, `g-d${DERIVED_GRAMMAR_MAX}`);
  assert.ok(weekVM.build.rejects.some((r) => r.type === "derived-grammar" && /more than/.test(r.reason)));
  assert.ok(weekVM.build.rejects.some((r) => r.type === "derived-grammar" && /duplicate/.test(r.reason)));
  // A wire that is mostly bad derived quotes trips the re-prompt ratio like any other quote field.
  const bad = mkWire({ grammarGroups: [{ pattern: "P", rule: null, items: [derivedItem({ said: "never said one" }), derivedItem({ said: "never said two" })] }] });
  assert.ok(buildWeekVM({ window: WIN, lessons: [derivedLesson()], wire: bad, now: NOW }).rejectRatio > REPROMPT_THRESHOLD);
});

test("a legacy grammar item (correctionId only, no said/fix/lessonId keys) still resolves as anchored", () => {
  const lesson = mkLesson({ corrections: [{ id: "c1", said: "I go", fix: "I went", why: "past" }] });
  const wire = mkWire({ grammarGroups: [{ pattern: "Past tense", rule: null, items: [{ correctionId: "c1", why: "over" }] }] });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  assert.equal(weekVM.grammarGroups[0].items[0].id, "g-c1");
  assert.equal(weekVM.grammarGroups[0].items[0].derived, false);
  assert.equal(weekVM.integrity.derivedGrammar, 0);
});

// ── v2: vocabulary.example — shown only when no clean verbatim usage survived ─────

test("a vocab example is kept only when the quote was NOT a clean usage and the example is a short real usage of the term", () => {
  const notUsage = "could you explain what that word means?";
  const usage = "I am not very tech savvy at all";
  const lesson = mkLesson({ transcript: [{ text: notUsage, speaker: "student" }, { text: usage, speaker: "student" }] });
  const vocab = (quote, example) => ({ term: "tech savvy", meaning: "good with technology", quote, quoteBy: "student", lessonId: "L1", fromCorrectionId: null, example });
  const build = (v) => buildWeekVM({ window: WIN, lessons: [lesson], wire: mkWire({ vocabulary: [v] }), now: NOW }).weekVM.vocabulary[0];

  const kept = build(vocab(notUsage, "My brother is very tech savvy."));
  assert.equal(kept.quote, null);
  assert.equal(kept.example, "My brother is very tech savvy.");

  const cleanQuote = build(vocab(usage, "My brother is very tech savvy."));
  assert.equal(cleanQuote.quote, usage);
  assert.equal(cleanQuote.example, null, "a clean verbatim quote wins; the model sentence is dropped");

  assert.equal(build(vocab(notUsage, "My brother is very good with computers.")).example, null, "example must contain the term");
  assert.equal(build(vocab(notUsage, "My brother, who lives in a small town near the coast, is very tech savvy indeed.")).example, null, "≤ 14 words");
  assert.equal(build(vocab(notUsage, "Tech savvy means good with technology.")).example, null, "a definition is not a usage");
  assert.equal(build(vocab(notUsage, null)).example, null);
  assert.equal(build(vocab(notUsage, "   ")).example, null);
  // A legacy wire item without an `example` key → null.
  const legacy = { term: "tech savvy", meaning: "m", quote: notUsage, quoteBy: "student", lessonId: "L1", fromCorrectionId: null };
  assert.equal(buildWeekVM({ window: WIN, lessons: [lesson], wire: mkWire({ vocabulary: [legacy] }), now: NOW }).weekVM.vocabulary[0].example, null);
});

test("a vocab example equal to a flagged error form (a Cambly correction or a derived said) is dropped", () => {
  const errSaid = "I'm a tech savvy, but I want to improve.";
  const lesson = mkLesson({
    transcript: [{ text: "what does that word mean", speaker: "student" }, { text: errSaid, speaker: "student" }],
    corrections: [{ id: "c1", said: errSaid, fix: "I'm tech savvy, but I want to improve.", why: "no article" }],
  });
  const wire = mkWire({
    vocabulary: [{ term: "tech savvy", meaning: "m", quote: "what does that word mean", quoteBy: "student", lessonId: "L1", fromCorrectionId: null, example: errSaid }],
    grammarGroups: [{ pattern: "Articles", rule: null, items: [{ correctionId: "c1", said: null, fix: null, why: "x", lessonId: null }] }],
  });
  assert.equal(buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW }).weekVM.vocabulary[0].example, null);
});

// ── v2: review / level / plan composition + guards ──────────────────────────────

const reviewLesson = () =>
  mkLesson({
    transcript: [
      { text: "I go to office every day", speaker: "student" },
      { text: "Try: I go to the office", speaker: "tutor" },
    ],
  });

function validLevel(over = {}) {
  return {
    overall: "B1+",
    confidence: "medium",
    dimensions: LEVEL_DIMENSIONS.map((name) => ({ name, band: "B1+", evidence: `${name} evidence` })),
    summary: "Long turns, systematic slips.",
    advice: [{ title: "A", detail: "a" }, { title: "B", detail: "b" }, { title: "C", detail: "c" }],
    ...over,
  };
}

function validPlan(over = {}) {
  return {
    focus: "Articles every time.",
    items: [{ day: "Mon", task: "Say it aloud.", why: "sticks" }, { day: "Daily", task: "Six sentences.", why: "" }],
    askTutor: ["Ask Alex to stop you on every missing article."],
    ...over,
  };
}

test("a legacy wire (no review/level/plan) composes a VM WITHOUT those keys; the empty stub is unchanged", () => {
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [reviewLesson()], wire: mkWire(), now: NOW });
  assert.ok(!("review" in weekVM) && !("level" in weekVM) && !("plan" in weekVM));
  assert.equal(weekVM.integrity.derivedGrammar, 0);
  const stub = buildEmptyWeekVM({ window: WIN, model: "m", now: NOW });
  assert.ok(!("review" in stub) && !("level" in stub) && !("plan" in stub) && !("derivedGrammar" in stub.integrity));
});

test("review composes with guarded quotes: any side for wentWell, student side for needsWork; a miss NULLS the quote and keeps the item", () => {
  const wire = mkWire({
    review: {
      summary: "A steady week.",
      wentWell: [
        { point: "You took the tutor's fix on board", quote: "Try: I go to the office", lessonId: "L1" }, // tutor line, any side → kept
        { point: "Long turns", quote: "never said this", lessonId: "L1" }, // miss → nulled, kept
        { point: "", quote: null, lessonId: null }, // blank → dropped
        { point: "Unknown lesson", quote: "I go to office every day", lessonId: "L9" }, // unknown lesson → quote + lessonId null
      ],
      needsWork: [
        { issue: "Articles", fix: "Say 'the office'.", quote: "i go to office every day", lessonId: "L1" }, // case differs → kept
        { issue: "Tutor line", fix: "x", quote: "Try: I go to the office", lessonId: "L1" }, // tutor line on the student side → nulled
        { issue: "No fix", fix: "", quote: null, lessonId: null }, // dropped
      ],
    },
  });
  const built = buildWeekVM({ window: WIN, lessons: [reviewLesson()], wire, now: NOW });
  const r = built.weekVM.review;
  assert.equal(r.summary, "A steady week.");
  assert.deepEqual(r.wentWell, [
    { point: "You took the tutor's fix on board", quote: "Try: I go to the office", lessonId: "L1" },
    { point: "Long turns", quote: null, lessonId: "L1" },
    { point: "Unknown lesson", quote: null, lessonId: null },
  ]);
  assert.deepEqual(r.needsWork, [
    { issue: "Articles", fix: "Say 'the office'.", quote: "i go to office every day", lessonId: "L1" },
    { issue: "Tutor line", fix: "x", quote: null, lessonId: "L1" },
  ]);
  // Misses are logged as quote-guard entries that did NOT drop the item, and they count toward the re-prompt ratio.
  const misses = built.weekVM.build.rejects.filter((x) => x.type === "quote-guard" && x.section === "review");
  assert.equal(misses.length, 3);
  assert.ok(misses.every((x) => x.dropped === false));
  assert.equal(built.weekVM.integrity.rejectedCount, 0, "nulled quotes are not dropped items");
  assert.ok(built.rejectRatio > 0);
  assert.doesNotThrow(() => validateWeek(built.weekVM));
});

test("review lists are capped (4 / 6) and a review with an empty summary is omitted + logged", () => {
  const many = mkWire({
    review: {
      summary: "s",
      wentWell: Array.from({ length: 6 }, (_, i) => ({ point: `p${i}`, quote: null, lessonId: null })),
      needsWork: Array.from({ length: 8 }, (_, i) => ({ issue: `i${i}`, fix: `f${i}`, quote: null, lessonId: null })),
    },
  });
  const r = buildWeekVM({ window: WIN, lessons: [reviewLesson()], wire: many, now: NOW }).weekVM.review;
  assert.equal(r.wentWell.length, 4);
  assert.equal(r.needsWork.length, 6);
  const none = buildWeekVM({ window: WIN, lessons: [reviewLesson()], wire: mkWire({ review: { summary: "  ", wentWell: [], needsWork: [] } }), now: NOW }).weekVM;
  assert.ok(!("review" in none));
  assert.ok(none.build.rejects.some((x) => x.type === "review" && /summary/.test(x.reason)));
});

test("level composes bandIndex, canonical dimension order, inherited missing dimensions, confidence fallback and a ≤3 advice cap (never padded)", () => {
  const wire = mkWire({
    level: validLevel({
      confidence: "very", // unknown → low
      dimensions: [
        { name: "fluency", band: "B2", evidence: "77 wpm" },
        { name: "spelling", band: "C1", evidence: "ignored" }, // not a canonical dimension
        { name: "Range", band: "B1", evidence: "case-insensitive name" },
        { name: "accuracy", band: "Z9", evidence: "bad band → treated as missing" },
        { name: "interaction", band: "B1+", evidence: "" },
        // coherence missing → inherits the overall band
      ],
      advice: [{ title: "A", detail: "a" }, { title: "", detail: "blank title dropped" }, { title: "B", detail: "b" }, { title: "C", detail: "c" }, { title: "D", detail: "d" }],
    }),
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [reviewLesson()], wire, now: NOW });
  const l = weekVM.level;
  assert.equal(l.overall, "B1+");
  assert.equal(l.bandIndex, BANDS.indexOf("B1+"));
  assert.equal(l.confidence, "low");
  assert.deepEqual(l.dimensions.map((d) => d.name), [...LEVEL_DIMENSIONS]);
  assert.deepEqual(l.dimensions.map((d) => d.band), ["B1", "B1+", "B2", "B1+", "B1+"]);
  assert.deepEqual(l.dimensions.map((d) => d.bandIndex), [2, 3, 4, 3, 3]);
  assert.equal(l.dimensions[1].evidence, "", "an invalid-band dimension inherits overall with empty evidence");
  assert.equal(l.dimensions[4].evidence, "", "a missing dimension inherits overall with empty evidence");
  assert.equal(l.dimensions[0].evidence, "case-insensitive name");
  assert.deepEqual(l.advice.map((a) => a.title), ["A", "B", "C"]);
  assert.equal(l.summary, "Long turns, systematic slips.");
  assert.ok(weekVM.build.rejects.some((x) => x.type === "level" && /coherence/.test(x.reason)));
  assert.doesNotThrow(() => validateWeek(weekVM));
  // Fewer than three valid advice items are kept as-is — no invented padding.
  const one = buildWeekVM({ window: WIN, lessons: [reviewLesson()], wire: mkWire({ level: validLevel({ advice: [{ title: "Only", detail: "one" }] }) }), now: NOW }).weekVM.level;
  assert.equal(one.advice.length, 1);
});

test("level is omitted + logged on an unknown overall band or an empty summary", () => {
  const bad = buildWeekVM({ window: WIN, lessons: [reviewLesson()], wire: mkWire({ level: validLevel({ overall: "Z9" }) }), now: NOW }).weekVM;
  assert.ok(!("level" in bad));
  assert.ok(bad.build.rejects.some((x) => x.type === "level" && x.dropped && /unknown band/.test(x.reason)));
  const blank = buildWeekVM({ window: WIN, lessons: [reviewLesson()], wire: mkWire({ level: validLevel({ summary: " " }) }), now: NOW }).weekVM;
  assert.ok(!("level" in blank));
});

test("nextWeekLabel is the label of the week AFTER the window, from the weekId alone", () => {
  assert.equal(nextWeekLabel(WIN), "May 18–24"); // WIN = week of 2026-05-11
  assert.equal(nextWeekLabel({ weekId: "2026-05-25" }), "Jun 1–7"); // month-crossing next week
  assert.equal(nextWeekLabel({ weekId: "2026-06-22" }), "Jun 29 – Jul 5");
});

test("plan composes with the builder-derived next-week label; unknown days / blank tasks are dropped, lists capped, non-string why → ''", () => {
  const wire = mkWire({
    plan: validPlan({
      items: [
        ...Array.from({ length: 8 }, (_, i) => ({ day: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Daily"][i], task: `task ${i}`, why: i === 0 ? null : `why ${i}` })),
        { day: "Funday", task: "dropped", why: "" },
        { day: "Mon", task: "  ", why: "dropped" },
      ],
      askTutor: ["a", "b", "c", "d", ""],
    }),
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [reviewLesson()], wire, now: NOW });
  const p = weekVM.plan;
  assert.equal(p.weekLabel, "May 18–24");
  assert.equal(p.focus, "Articles every time.");
  assert.equal(p.items.length, 7);
  assert.deepEqual(p.items[0], { day: "Mon", task: "task 0", why: "" });
  assert.deepEqual(p.items.map((i) => i.day), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  assert.deepEqual(p.askTutor, ["a", "b", "c"]);
  assert.ok(weekVM.build.rejects.some((x) => x.type === "plan" && !x.dropped && /2 plan item/.test(x.reason)));
  assert.doesNotThrow(() => validateWeek(weekVM));
});

test("plan is omitted + logged on an empty focus or when no valid item survives", () => {
  const noFocus = buildWeekVM({ window: WIN, lessons: [reviewLesson()], wire: mkWire({ plan: validPlan({ focus: "" }) }), now: NOW }).weekVM;
  assert.ok(!("plan" in noFocus));
  assert.ok(noFocus.build.rejects.some((x) => x.type === "plan" && x.dropped && /focus/.test(x.reason)));
  const noItems = buildWeekVM({ window: WIN, lessons: [reviewLesson()], wire: mkWire({ plan: validPlan({ items: [{ day: "Someday", task: "x", why: "" }] }) }), now: NOW }).weekVM;
  assert.ok(!("plan" in noItems));
});

test("a full v2 wire composes every block, keeps the legacy key set + review/level/plan, and passes both render gates", () => {
  const lesson = derivedLesson();
  const wire = mkWire({
    classes: [{ lessonId: "L1", title: "Work routines & lunch", moment: { text: "m", quotes: [] }, tutorNote: null }],
    grammarGroups: [{ pattern: "Plural -s", rule: null, items: [derivedItem()] }],
    review: { summary: "s", wentWell: [{ point: "p", quote: null, lessonId: null }], needsWork: [{ issue: "i", fix: "f", quote: null, lessonId: null }] },
    level: validLevel(),
    plan: validPlan(),
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  assert.deepEqual(Object.keys(weekVM).sort(), [
    "build", "classes", "endDate", "grammarGroups", "integrity", "isEmpty", "level", "phrasing", "plan", "practice",
    "publishedAt", "review", "schemaVersion", "startDate", "stats", "vocabulary", "weekId", "weekLabel",
  ]);
  assert.doesNotThrow(() => validateWeek(weekVM));
  assert.doesNotThrow(() => assertSigma(weekVM));
  // Deterministic: byte-identical on identical inputs.
  const again = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW }).weekVM;
  assert.equal(JSON.stringify(again), JSON.stringify(weekVM));
});

// ── generateWeekVM — orchestration + corrective re-prompt (I-SM ④) ─────────────

/** Start a mock OpenAI server for generateWeekVM (per-call scripted responses). */
async function startMock(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const idx = requests.length;
      requests.push({ body: raw });
      const { status = 200, body = "" } = handler(idx, raw) || {};
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(r)) };
}
function envelope(wire) {
  return JSON.stringify({ choices: [{ message: { content: JSON.stringify(wire) } }], usage: { prompt_tokens: 100 } });
}

test("generateWeekVM short-circuits an empty week with the stub and zero LLM calls", async () => {
  const out = await generateWeekVM({ window: WIN, lessons: [], model: "gpt-5.1", now: NOW });
  assert.equal(out.llmCalls, 0);
  assert.equal(out.weekVM.isEmpty, true);
});

test("generateWeekVM makes exactly one call on a clean week and sends the week header in the bundle", async () => {
  const lesson = mkLesson({ transcript: [{ text: "I like coffee", speaker: "student" }], corrections: [] });
  const cleanWire = { classes: [], vocabulary: [{ term: "coffee", meaning: "drink", quote: "I like coffee", quoteBy: "student", lessonId: "L1", fromCorrectionId: null }], grammarGroups: [], phrasing: [], practice: [] };
  const mock = await startMock(() => ({ status: 200, body: envelope(cleanWire) }));
  try {
    const out = await generateWeekVM({ window: WIN, lessons: [lesson], now: NOW, base: mock.base, ...FAST });
    assert.equal(out.llmCalls, 1);
    assert.equal(out.reprompted, false);
    assert.equal(out.weekVM.vocabulary.length, 1);
    const bundle = JSON.parse(mock.requests[0].body).messages[1].content;
    assert.ok(bundle.startsWith(`## Week of ${WIN.weekLabel} — 1 class · tutors: Sam Rivers`), bundle.split("\n")[0]);
  } finally {
    await mock.close();
  }
});

test("I-SM④ >30% quote rejects triggers exactly one corrective re-prompt, then succeeds", async () => {
  const lesson = mkLesson({ transcript: [{ text: "I love coffee", speaker: "student" }], corrections: [] });
  const badWire = { classes: [], vocabulary: [{ term: "coffee", meaning: "drink", quote: "I HATE coffee", quoteBy: "student", lessonId: "L1", fromCorrectionId: null }], grammarGroups: [], phrasing: [], practice: [] };
  const goodWire = { classes: [], vocabulary: [{ term: "coffee", meaning: "drink", quote: "I love coffee", quoteBy: "student", lessonId: "L1", fromCorrectionId: null }], grammarGroups: [], phrasing: [], practice: [] };
  const mock = await startMock((i) => ({ status: 200, body: envelope(i === 0 ? badWire : goodWire) }));
  try {
    const out = await generateWeekVM({ window: WIN, lessons: [lesson], now: NOW, base: mock.base, ...FAST });
    assert.equal(out.llmCalls, 2);
    assert.equal(out.reprompted, true);
    assert.equal(out.weekVM.vocabulary.length, 1);
    // The second request carries the corrective rejection appendix (3 messages, not 2).
    const secondMessages = JSON.parse(mock.requests[1].body).messages;
    assert.equal(secondMessages.length, 3);
    assert.match(secondMessages[2].content, /CORRECTION REQUIRED/);
  } finally {
    await mock.close();
  }
});

test("generateWeekVM throws SummarizeQualityError when the re-prompt still exceeds the threshold", async () => {
  const lesson = mkLesson({ transcript: [{ text: "I love coffee", speaker: "student" }], corrections: [] });
  const badWire = { classes: [], vocabulary: [{ term: "coffee", meaning: "drink", quote: "I HATE coffee", quoteBy: "student", lessonId: "L1", fromCorrectionId: null }], grammarGroups: [], phrasing: [], practice: [] };
  const mock = await startMock(() => ({ status: 200, body: envelope(badWire) }));
  try {
    await assert.rejects(
      () => generateWeekVM({ window: WIN, lessons: [lesson], now: NOW, base: mock.base, ...FAST }),
      (e) => e instanceof SummarizeQualityError && e.rejectRatio > REPROMPT_THRESHOLD,
    );
    assert.equal(mock.requests.length, 2); // one initial + one corrective, then fail
  } finally {
    await mock.close();
  }
});

// ── recent-shape week end-to-end (0 corrections) — the four fixes together ─────
// Real recent fixtures: scheduledMinutes>0, 0 corrective corrections, rich ai_tutor
// coaching, long transcripts. The mocked summarizer emits what the real one would for
// such a week — no grammar, vocab+phrasing quoting real student lines, a moment whose
// highlight is a real corpus line the prose does NOT embed, and practice that cites
// lessonIds (there are no correction ids to cite). All four bug fixes must hold.

test(
  "recent-shape week: minutes>0, non-empty practice without grammar, populated tutorFocus, ~0 moment rejects",
  { skip: recentFixturesSkip() },
  async () => {
    const lessons = presentRecentLessonDirs()
      .map((d) => normalizeLessonDir(d, { uid: REAL_STUDENT_UID }))
      .filter((l) => l.lessonId && l.transcript.some((t) => t.speaker === "student"));
    assert.ok(lessons.length > 0, "expected recent lessons with student transcript lines");

    const win = weekWindow(Date.parse(lessons[0].startAtCST));
    const anchor = lessons[0];
    const anchorLine = anchor.transcript.find((t) => t.speaker === "student").text;

    const wire = mkWire({
      classes: lessons.map((l) => {
        const s = l.transcript.find((t) => t.speaker === "student");
        // moment.text is prose that does NOT embed the highlight — the old spam shape.
        return { lessonId: l.lessonId, moment: { text: "A memorable stretch of the conversation.", quotes: s ? [s.text] : [] }, tutorNote: null };
      }),
      vocabulary: [{ term: "a real phrase", meaning: "something said in class", quote: anchorLine, quoteBy: "student", lessonId: anchor.lessonId, fromCorrectionId: null }],
      phrasing: [{ said: anchorLine, better: "a smoother version of it", why: "sounds more natural", lessonId: anchor.lessonId, fromCorrectionId: null }],
      // No correction ids exist this week → practice cites lessonIds instead.
      practice: lessons.slice(0, 2).map((l, i) => ({
        format: i === 0 ? "FILL_THE_GAP" : "SAY_IT_BETTER",
        prompt: "____ from this week",
        cue: null,
        answer: "**answer**",
        why: "drawn from this week's material",
        sourceIds: [l.lessonId],
      })),
    });

    const mock = await startMock(() => ({ status: 200, body: envelope(wire) }));
    try {
      const out = await generateWeekVM({ window: win, lessons, now: NOW, base: mock.base, ...FAST });
      const vm = out.weekVM;

      // Bug 1 — minutes surfaced from scheduledMinutes and summed from the classes.
      assert.ok(vm.stats.minutes > 0, `stats.minutes>0 (got ${vm.stats.minutes})`);
      assert.equal(vm.stats.minutes, vm.classes.reduce((n, c) => n + c.minutes, 0));

      // Bug 2 — practice is independent of grammar: non-empty despite zero grammar.
      assert.equal(vm.grammarGroups.length, 0);
      assert.ok(vm.practice.length > 0, `practice non-empty (got ${vm.practice.length})`);
      assert.ok(vm.build.rejects.every((r) => r.type !== "lineage"), "no lineage rejects");

      // Bug 3 — moment rejects near zero (real corpus highlights, no substring spam).
      assert.equal(vm.build.rejects.filter((r) => r.section === "moment" && r.dropped).length, 0);
      const withMoment = vm.classes.find((c) => c.moment);
      assert.ok(withMoment && withMoment.moment.quotes.length > 0, "the moment kept its corpus highlight");

      // Bug 4 — tutorFocus populated verbatim from the ai_tutor coaching block.
      const focus = vm.classes.map((c) => c.tutorFocus).find((f) => f && f.nextFocus);
      assert.ok(focus, "at least one class carries a populated tutorFocus");
      assert.equal(typeof focus.aiFeedback, "string");
      assert.equal(typeof focus.tutorNotes, "string");
      assert.equal(typeof focus.nextFocus, "string");

      // Σ intact for a zero-correction week; renders through the fail-closed gate.
      assert.equal(vm.stats.corrections, 0);
      assert.equal(vm.integrity.renderedGrammar + vm.integrity.renderedVocab + vm.integrity.renderedPhrasing, 0);
      assert.equal(out.llmCalls, 1);
      assert.equal(out.reprompted, false);
      assert.doesNotThrow(() => validateWeek(vm));
    } finally {
      await mock.close();
    }
  },
);

// ── polish pass: gloss-shaped vocab quotes · tutorNote shown once · compose.js re-exports ──

test("a quote that opens with the term + a separator and then a gloss ('term, gloss' · 'term/ gloss' · 'term: gloss') is a definition, not a usage — the clean LLM example shows instead", () => {
  const glosses = [
    ["tourist trap", "Tourist trap, a place that attracts many tourists and charges them too much"],
    ["attire", "attire/ clothes you wear"],
    ["paradox", "Paradox: a situation that seems impossible but is actually true"],
  ];
  const lesson = mkLesson({ transcript: glosses.map(([, text]) => ({ text, speaker: "tutor" })) });
  const wire = mkWire({
    vocabulary: glosses.map(([term, quote]) => ({
      term, meaning: "m", quote, quoteBy: "tutor", lessonId: "L1", fromCorrectionId: null,
      example: `We talked about the ${term} in class.`,
    })),
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [lesson], wire, now: NOW });
  for (const [term] of glosses) {
    const v = weekVM.vocabulary.find((x) => x.term === term);
    assert.equal(v.quote, null, `${term}: the gloss is not a usage`);
    assert.equal(v.quoteBy, null);
    assert.equal(v.example, `We talked about the ${term} in class.`, `${term}: the clean model sentence fills in (existing RULE 8 path)`);
  }
  assert.equal(weekVM.build.rejects.filter((r) => r.type === "vocab-example").length, 3, "each drop is logged, item kept");
  assert.doesNotThrow(() => validateWeek(weekVM));
});

test("the gloss shape is case-insensitive, tolerates an inflected leading term and every listed separator; a real usage that merely starts with the term is kept", () => {
  const lines = {
    plural: "Tourist traps, places that attract too many visitors",
    dash: "Paradox - a statement that contradicts itself",
    emdash: "Attire — the clothes you wear for an occasion",
    paren: "Gossip (talk about other people's lives)",
    usage: "Attire matters more than you think at a wedding",
    compound: "Tourist-trap prices are always higher near the station",
    later: "I think a paradox, honestly, is hard to explain",
  };
  const lesson = mkLesson({ transcript: Object.values(lines).map((text) => ({ text, speaker: "student" })) });
  const vocab = (term, quote) => ({ term, meaning: "m", quote, quoteBy: "student", lessonId: "L1", fromCorrectionId: null, example: null });
  const quoteOf = (v) => buildWeekVM({ window: WIN, lessons: [lesson], wire: mkWire({ vocabulary: [v] }), now: NOW }).weekVM.vocabulary[0].quote;
  assert.equal(quoteOf(vocab("tourist trap", lines.plural)), null, "plural leading term + comma → gloss");
  assert.equal(quoteOf(vocab("paradox", lines.dash)), null, "spaced hyphen → gloss");
  assert.equal(quoteOf(vocab("attire", lines.emdash)), null, "em dash → gloss");
  assert.equal(quoteOf(vocab("gossip", lines.paren)), null, "opening parenthesis → gloss");
  assert.equal(quoteOf(vocab("attire", lines.usage)), lines.usage, "the term as the subject of a real sentence is a usage");
  assert.equal(quoteOf(vocab("tourist trap", lines.compound)), lines.compound, "a hyphenated compound is not a separator");
  assert.equal(quoteOf(vocab("paradox", lines.later)), lines.later, "a comma later in the line never trips it — the term must open the line");
});

test("classes[].tutorNote is dropped when Cambly's own tutorNotes reach the Focus box (the note shows once, verbatim); kept when the lesson has no tutor note", () => {
  const feedback = (tutorNotes) => ({ finalAIFeedback: { whatYouDidWell: "Great idioms today." }, tutorNotes, tutorNotesTranslated: null, finalSuggestedNextLesson: null });
  const withNote = mkLesson({ lessonId: "A", startAtCST: "2026-05-13T09:00:00+08:00", aiTutorFeedback: feedback("You made class fly by, see you Thursday!") });
  // B: no Cambly tutor note, but the tutor DID type "Keep it up!" in chat → verbatim → kept.
  const noNote = mkLesson({ lessonId: "B", startAtCST: "2026-05-14T09:00:00+08:00", aiTutorFeedback: feedback(null), chat: [{ text: "Keep it up!", from: "tutor" }] });
  const legacy = mkLesson({ lessonId: "C", startAtCST: "2026-05-15T09:00:00+08:00" }); // no ai_tutor feedback at all
  const wire = mkWire({
    classes: [
      // A topic summary the LLM put in tutorNote — must not render beside the tutor's real note.
      { lessonId: "A", moment: { text: "m", quotes: [] }, tutorNote: "We discussed work routines and the past tense." },
      { lessonId: "B", moment: { text: "m", quotes: [] }, tutorNote: "Keep it up!" },
      { lessonId: "C", moment: { text: "m", quotes: [] }, tutorNote: "Nice work." },
    ],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [withNote, noNote, legacy], wire, now: NOW });
  const [a, b, c] = weekVM.classes;
  assert.equal(a.tutorNote, null, "the Focus box already shows the tutor's note verbatim");
  assert.equal(a.tutorFocus.tutorNotes, "You made class fly by, see you Thursday!");
  assert.equal(b.tutorNote, "Keep it up!", "no Cambly tutor note + a verbatim tutor chat line → the wire note stays");
  assert.equal(b.tutorFocus.tutorNotes, null);
  assert.equal(c.tutorNote, null, "RULE 13 (Codex, PR #4): a wire note that is not a verbatim tutor line is dropped, never published as tutor feedback");
  assert.ok(weekVM.build.rejects.some((r) => r.type === "quote-guard" && r.section === "tutorNote" && r.lessonId === "C"), "the drop is logged");
  assert.equal(c.tutorFocus, null);
  assert.doesNotThrow(() => validateWeek(weekVM));
});

test("refactor: build.js keeps its public exports — humanizePattern / nextWeekLabel are the compose.js functions re-exported", async () => {
  const compose = await import("../src/compose.js");
  assert.equal(humanizePattern, compose.humanizePattern);
  assert.equal(nextWeekLabel, compose.nextWeekLabel);
  assert.equal(typeof compose.composeReview, "function");
  assert.equal(typeof compose.composeLevel, "function");
  assert.equal(typeof compose.composePlan, "function");
  assert.equal(typeof compose.tutorFocusOf, "function");
});
