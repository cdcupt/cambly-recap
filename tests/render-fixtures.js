// tests/render-fixtures.js — SYNTHETIC WeekVM fixtures for the renderer suite.
//
// PRD S6: the repo carries NO real lesson data. Every string below is invented
// dialogue authored to exercise a renderer edge (curly-quote → <q>, gap markup,
// **bold**, cue, an <script> XSS probe, fromCorrectionId Σ counting, the >3-item
// grammar collapse, tutor-quote attribution). Safe to commit.

/** A complete, contract-valid non-empty week (Σ = 2 grammar + 1 vocab + 1 phrasing = 4;
 *  stats.corrections = renderedGrammar = 2, the raw Σ anchor 4 lives in integrity). */
export function goldenWeek(overrides = {}) {
  return {
    schemaVersion: 1,
    weekId: "2026-05-25",
    weekLabel: "May 25 – 31, 2026",
    startDate: "2026-05-25",
    endDate: "2026-05-31",
    publishedAt: "2026-06-01T07:30:00+08:00",
    isEmpty: false,
    stats: { classes: 2, minutes: 90, corrections: 2, expressions: 2 },
    classes: [
      {
        lessonId: "L1",
        startAt: "2026-05-28T20:00:00+08:00", // Thu CST
        minutes: 30,
        topic: "Food for Thought",
        tutor: "Alex R.",
        stats: { wpm: 75, talkPct: 43, words: 290, fixes: 2 },
        moment: {
          text: "You read “I cut out soda” then made it yours: “I cut out the Coke.”",
          quotes: ["I cut out soda", "I cut out the Coke."],
        },
        tutorNote: "“Great conversation today!” — Alex R.",
      },
      {
        lessonId: "L2",
        startAt: "2026-05-30T20:00:00+08:00", // Sat CST
        minutes: 60,
        topic: "Screen habits <script>alert(1)</script>", // XSS probe in a display field
        tutor: "Alex R.",
        stats: { wpm: 77, talkPct: 42, words: 466, fixes: 2 },
        moment: {
          text: "Alex typed “eating out can expand my exposure” live.",
          quotes: ["eating out can expand my exposure"],
        },
        tutorNote: null,
      },
    ],
    vocabulary: [
      {
        id: "v1",
        term: "fad diet",
        meaning: "a diet popular fast <script>x</script>", // XSS probe
        quote: "diets that become popular very quickly",
        quoteBy: "student",
        lessonId: "L1",
        fromCorrectionId: null,
      },
      {
        id: "v2",
        term: "binge-watching",
        meaning: "watching too much TV at once",
        quote: "This is called binge watching.",
        quoteBy: "tutor",
        lessonId: "L2",
        fromCorrectionId: "c3", // counts toward Σ
      },
    ],
    grammarGroups: [
      {
        pattern: "Third-person -s",
        rule: "he / she / it → the present verb takes -s.",
        items: [
          {
            id: "g1",
            said: "my wife like shopping",
            fix: "my wife likes shopping",
            why: "agree with the singular subject",
            lessonId: "L1",
            correctionId: "c1",
          },
          {
            id: "g2",
            said: "Japan have Chinese food",
            fix: "Japan has Chinese food",
            why: "singular subject → has",
            lessonId: "L2",
            correctionId: "c2",
          },
        ],
      },
    ],
    phrasing: [
      {
        id: "p1",
        said: "I eat punctual.",
        better: "I eat on time.",
        why: "‘punctual’ describes a person; the action happens on time",
        lessonId: "L1",
        fromCorrectionId: "c4", // counts toward Σ
      },
    ],
    practice: [
      {
        id: "pr1",
        format: "FILL_THE_GAP",
        prompt: "Now my wife ____ shopping.",
        cue: "like",
        answer: "Now my wife **likes** shopping.",
        why: "singular subject → the verb takes -s",
        lessonId: "L1",
        sourceIds: ["g1"],
      },
      {
        id: "pr2",
        format: "SAY_IT_BETTER",
        prompt: "“I eat punctual.”",
        cue: null,
        answer: "I eat **on time**.",
        why: "the action happens on time",
        lessonId: "L1",
        sourceIds: ["p1"],
      },
    ],
    integrity: {
      reportedCorrections: 4,
      renderedGrammar: 2,
      renderedVocab: 1,
      renderedPhrasing: 1,
      rejectedCount: 0,
    },
    build: { model: "synthetic", promptTokens: 0, rejects: [] },
    ...overrides,
  };
}

/**
 * A RECENT-data-shape non-empty week: zero grammar corrections, per-class ai_tutor
 * coaching (tutorFocus), real scheduledMinutes, one vocab expression and a practice
 * drill whose lineage resolves to a lessonId (grammar-independent). Σ closes on zero
 * corrections (grammar 0 + vocab 0 + phrasing 0). Every string is invented dialogue
 * authored to exercise the Focus & tutor feedback block (AI summary, tutor note + its
 * Chinese line, the Next-focus chip) and a tutorFocus XSS probe. Safe to commit.
 */
export function recentWeek(overrides = {}) {
  return {
    schemaVersion: 1,
    weekId: "2026-06-22",
    weekLabel: "Jun 22 – 28, 2026",
    startDate: "2026-06-22",
    endDate: "2026-06-28",
    publishedAt: "2026-06-29T07:30:00+08:00",
    isEmpty: false,
    stats: { classes: 2, minutes: 90, corrections: 0, expressions: 1 },
    classes: [
      {
        lessonId: "R1",
        startAt: "2026-06-23T20:00:00+08:00", // Tue CST
        minutes: 60,
        topic: "Work Stories",
        tutor: "Marta P.",
        stats: { wpm: 82, talkPct: 55, words: 512, fixes: 0 },
        moment: {
          text: "You narrated a whole meeting in the past tense unprompted.",
          quotes: [],
        },
        tutorNote: null,
        tutorFocus: {
          aiFeedback:
            "You spoke with real confidence today and kept the past tense steady across a long story.",
          tutorNotes:
            "Great flow. Keep an eye on irregular past verbs when you speed up.",
          tutorNotesZh: "表达很流畅。加快语速时注意不规则动词的过去式。",
          nextFocus: "Maintaining Past Tense While Narrating Work Stories",
        },
      },
      {
        lessonId: "R2",
        startAt: "2026-06-26T20:00:00+08:00", // Fri CST
        minutes: 30,
        topic: "Weekend Plans <script>alert(2)</script>", // XSS probe in a display field
        tutor: "Marta P.",
        stats: { wpm: 80, talkPct: 52, words: 260, fixes: 0 },
        moment: null,
        tutorNote: null,
        // Partial tutorFocus: only nextFocus present (also an XSS probe) — exercises the
        // per-field render path and proves tutorFocus content is escaped.
        tutorFocus: {
          aiFeedback: null,
          tutorNotes: null,
          tutorNotesZh: null,
          nextFocus: "Using future forms for plans <script>x</script>",
        },
      },
    ],
    vocabulary: [
      {
        id: "v-1",
        term: "unwind",
        meaning: "to relax after work",
        quote: "I like to unwind on Fridays",
        quoteBy: "student",
        lessonId: "R1",
        fromCorrectionId: null, // expressions=1, does NOT count toward Σ
      },
    ],
    grammarGroups: [], // recent shape: zero grammar corrections
    phrasing: [],
    practice: [
      {
        id: "pr-1",
        format: "SAY_IT_BETTER",
        prompt: "Say how you spent last weekend, in the past tense.",
        cue: null,
        answer: "Last weekend I **visited** my parents and we **cooked** together.",
        why: "keep the past tense steady across the whole story",
        lessonId: "R1",
        sourceIds: ["R1"], // lineage resolves to a lessonId (grammar-independent)
      },
    ],
    integrity: {
      reportedCorrections: 0,
      renderedGrammar: 0,
      renderedVocab: 0,
      renderedPhrasing: 0,
      rejectedCount: 0,
    },
    build: { model: "synthetic", promptTokens: 0, rejects: [] },
    ...overrides,
  };
}

/** A contract-valid isEmpty stub — index row only, no page. */
export function emptyWeek(weekId = "2026-06-08", weekLabel = "Jun 8 – 14, 2026") {
  return {
    schemaVersion: 1,
    weekId,
    weekLabel,
    startDate: weekId,
    endDate: "2026-06-14",
    publishedAt: "2026-06-15T07:30:00+08:00",
    isEmpty: true,
    stats: { classes: 0, minutes: 0, corrections: 0, expressions: 0 },
    classes: [],
    vocabulary: [],
    grammarGroups: [],
    phrasing: [],
    practice: [],
    integrity: {
      reportedCorrections: 0,
      renderedGrammar: 0,
      renderedVocab: 0,
      renderedPhrasing: 0,
      rejectedCount: 0,
    },
    build: { model: "synthetic", promptTokens: 0, rejects: [] },
  };
}

/**
 * A minimal non-empty week at an arbitrary id — one class, one grammar group with
 * `n` items (to exercise the >3 collapse), Σ closed on grammar alone.
 */
export function weekWith(weekId, weekLabel, grammarItemCount = 2, extra = {}) {
  const items = Array.from({ length: grammarItemCount }, (_, i) => ({
    id: `g${i + 1}`,
    said: `wrong ${i + 1}`,
    fix: `right ${i + 1}`,
    why: `reason ${i + 1}`,
    lessonId: "LX",
    correctionId: `c${i + 1}`,
  }));
  const day = `${weekId}T20:00:00+08:00`;
  return {
    schemaVersion: 1,
    weekId,
    weekLabel,
    startDate: weekId,
    endDate: weekId,
    publishedAt: `${weekId}T07:30:00+08:00`,
    isEmpty: false,
    stats: { classes: 1, minutes: 60, corrections: grammarItemCount, expressions: 0 },
    classes: [
      {
        lessonId: "LX",
        startAt: day,
        minutes: 60,
        topic: "Topic",
        tutor: "Tutor T.",
        stats: { wpm: 80, talkPct: 40, words: 400, fixes: grammarItemCount },
        moment: { text: "A neutral moment.", quotes: [] },
        tutorNote: null,
      },
    ],
    vocabulary: [],
    grammarGroups: [{ pattern: "Pattern", rule: null, items }],
    phrasing: [],
    practice: [],
    integrity: {
      reportedCorrections: grammarItemCount,
      renderedGrammar: grammarItemCount,
      renderedVocab: 0,
      renderedPhrasing: 0,
      rejectedCount: 0,
    },
    build: { model: "synthetic", promptTokens: 0, rejects: [] },
    ...extra,
  };
}

export function staleSiteState() {
  return {
    schemaVersion: 1,
    lastRunAt: "2026-07-06T07:30:00+08:00",
    lastOutcome: "auth-expired",
    authStale: true,
    authStaleSince: "2026-07-06",
    emailOk: true,
    recoveryCommands: [
      "Re-harvest your Cambly session in a browser and save cambly-state.json (see the README).",
      "Copy cambly-state.json to the server, then re-run the generator.",
    ],
  };
}

export function healthySiteState() {
  return {
    schemaVersion: 1,
    lastRunAt: "2026-06-01T07:30:00+08:00",
    lastOutcome: "published",
    authStale: false,
    authStaleSince: null,
    emailOk: true,
    recoveryCommands: [
      "Re-harvest your Cambly session in a browser and save cambly-state.json (see the README).",
      "Copy cambly-state.json to the server, then re-run the generator.",
    ],
  };
}
