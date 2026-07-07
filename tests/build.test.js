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
  quoteContainsTerm,
  SummarizeQualityError,
  REPROMPT_THRESHOLD,
} from "../src/build.js";

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

test("U-QG⑤ a case mismatch is rejected (normalization is case-preserving)", () => {
  assert.equal(quoteMatches("I Really Like Coffee.", quoteCorpus(corpusLesson), "student"), false);
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
  const l1 = mkLesson({ lessonId: "A", startAtCST: "2026-05-13T09:00:00+08:00", minutes: 30 });
  const l2 = mkLesson({ lessonId: "B", startAtCST: "2026-05-15T09:00:00+08:00", minutes: 25 });
  const wire = mkWire({
    classes: [
      { lessonId: "A", moment: { text: "first take", quotes: [] }, tutorNote: "nice" },
      { lessonId: "A", moment: { text: "DUPLICATE", quotes: [] }, tutorNote: "dup" }, // duplicate id → ignored
      // B omitted from the wire entirely
    ],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [l1, l2], wire, now: NOW });
  assert.deepEqual(weekVM.classes.map((c) => c.lessonId), ["A", "B"]); // exactly one card each
  assert.equal(weekVM.classes[0].tutorNote, "nice"); // first wire entry wins, not the dup
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
    tutorNotes: "You made class fly by!",
    tutorNotesZh: "你让课飞快！",
    nextFocus: "Maintaining Past Tense While Narrating Work Stories",
  });
  assert.equal(b.tutorFocus, null); // no ai_tutor feedback → null (older data shape)
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

test("a Focus-box coaching line that duplicates the class sign-off highlight is stripped (finding 2)", () => {
  const l = mkLesson({
    aiTutorFeedback: {
      finalAIFeedback: null,
      tutorNotes: "Thank you for visiting today! Looking forward to seeing you again soon",
      tutorNotesTranslated: null,
      finalSuggestedNextLesson: "Keep practising the past tense",
    },
  });
  const wire = mkWire({
    classes: [
      {
        lessonId: "L1",
        moment: { text: "A calm reflective close.", quotes: [] },
        tutorNote: "Thank you for visiting today! Looking forward to seeing you again soon 🎉",
      },
    ],
  });
  const { weekVM } = buildWeekVM({ window: WIN, lessons: [l], wire, now: NOW });
  const c = weekVM.classes[0];
  assert.match(c.tutorNote, /Thank you for visiting/); // the class highlight keeps it
  assert.equal(c.tutorFocus.tutorNotes, null); // stripped from the Focus box → shown once
  assert.equal(c.tutorFocus.nextFocus, "Keep practising the past tense"); // other fields intact
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

test("generateWeekVM makes exactly one call on a clean week", async () => {
  const lesson = mkLesson({ transcript: [{ text: "I like coffee", speaker: "student" }], corrections: [] });
  const cleanWire = { classes: [], vocabulary: [{ term: "coffee", meaning: "drink", quote: "I like coffee", quoteBy: "student", lessonId: "L1", fromCorrectionId: null }], grammarGroups: [], phrasing: [], practice: [] };
  const mock = await startMock(() => ({ status: 200, body: envelope(cleanWire) }));
  try {
    const out = await generateWeekVM({ window: WIN, lessons: [lesson], now: NOW, base: mock.base, ...FAST });
    assert.equal(out.llmCalls, 1);
    assert.equal(out.reprompted, false);
    assert.equal(out.weekVM.vocabulary.length, 1);
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
