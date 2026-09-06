// tests/normalize.test.js — normalizer against synthetic (portable) and real archive fixtures.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeLesson,
  normalizeLessonDir,
  normalizeTranscript,
  normalizeCorrections,
  normalizeChat,
  normalizeAiTutorFeedback,
  cleanCorrectionText,
  mergeTurns,
  normalizeTutors,
  mergeTutors,
  tutorDisplayName,
  lessonTutorId,
  ENDPOINT_FILES,
  unwrap,
  unwrapOid,
  unwrapDate,
} from "../src/normalize.js";

import {
  realFixturesSkip,
  presentLessonDirs,
  realEpochOf,
  archiveIndexByDir,
  recentFixturesSkip,
  presentRecentLessonDirs,
  EXPECTED_WEEK,
  REAL_STUDENT_UID,
  fixturesDir,
} from "./fixtures-real.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYNTH_DIR = path.join(HERE, "fixtures", "synthetic", "lesson-basic");
const SYNTH_UID = "student001";

// ── envelope / wrapper helpers ───────────────────────────────────────────────

test("unwrap strips the {result} envelope but leaves plain objects/arrays", () => {
  assert.deepEqual(unwrap({ result: [1, 2] }), [1, 2]);
  assert.deepEqual(unwrap({ transcript: [] }), { transcript: [] });
  assert.deepEqual(unwrap([1]), [1]);
});

test("unwrapOid / unwrapDate peel Mongo wrappers", () => {
  assert.equal(unwrapOid({ $oid: "abc" }), "abc");
  assert.equal(unwrapDate({ $date: 123 }), 123);
  assert.equal(unwrapOid("plain"), "plain");
});

// ── synthetic (committed, portable) fixture ──────────────────────────────────

test("normalizeLessonDir transforms the synthetic lesson end to end", () => {
  // Act
  const n = normalizeLessonDir(SYNTH_DIR, { uid: SYNTH_UID });

  // Assert — meta
  assert.equal(n.lessonId, "lesson-basic-001");
  assert.equal(n.weekId, "2026-05-11");
  assert.equal(n.startAtCST, "2026-05-13T10:30:00+08:00");
  assert.equal(n.weekday, "Wed");
  assert.equal(n.minutes, 30);
  assert.equal(n.tutor, "Sam Rivers");
  assert.equal(n.topic, "Weekend Plans");

  // Assert — stats
  assert.deepEqual(n.stats, { wpm: 68, talkRatio: 47, uniqueWords: 132 });

  // Assert — transcript speaker tagging by UID
  assert.equal(n.transcript.length, 6);
  assert.equal(n.transcript[0].speaker, "tutor");
  assert.equal(n.transcript[1].speaker, "student");
  assert.equal(n.transcript[1].text, "It was great. I go to the mountain with my family.");
  assert.equal(n.transcript[1].ts, 8.5);

  // Assert — corrections lifted to the Σ shape, ids unwrapped from $oid
  assert.equal(n.corrections.length, 2);
  assert.deepEqual(n.corrections[0], {
    id: "bbbb0000000000000000co01",
    said: "I go to the mountain with my family.",
    fix: "I went to the mountain with my family.",
    why: "The weekend is finished, so use the simple past 'went'.",
    category: "grammar",
    ts: 8.5,
  });

  // Assert — chat mapped with from-side, tutor notes collected
  assert.deepEqual(n.chat[0], { text: "hiked (past tense of hike)", from: "tutor" });
  assert.deepEqual(n.chat[1], { text: "thank you, hiked", from: "student" });
  assert.equal(n.tutorNotes.length, 1);
  assert.match(n.tutorNotes[0], /past-tense/);

  // Assert — ai_tutor block surfaced verbatim; synthetic carries only tutorNotes, the
  // finalAIFeedback/nextFocus/translation fields are absent (older data shape) → null.
  assert.ok(n.aiTutorFeedback, "aiTutorFeedback present when tutorNotes exist");
  assert.match(n.aiTutorFeedback.tutorNotes, /past-tense verbs/);
  assert.equal(n.aiTutorFeedback.finalAIFeedback, null);
  assert.equal(n.aiTutorFeedback.tutorNotesTranslated, null);
  assert.equal(n.aiTutorFeedback.finalSuggestedNextLesson, null);
});

test("normalizeTranscript handles a result-wrapped transcript envelope too", () => {
  const wrapped = { result: { transcript: [{ text: "hi", startOffsetSeconds: 1, userId: "u1" }] } };
  const out = normalizeTranscript(wrapped, "u1");
  assert.deepEqual(out, [{ text: "hi", ts: 1, speaker: "student" }]);
});

test("normalizeCorrections falls back to _id.$oid when id is absent", () => {
  const out = normalizeCorrections({
    result: [{ sentence: "a", correction: "b", reasoning: "c", category: "grammar", _id: { $oid: "X1" } }],
  });
  assert.equal(out[0].id, "X1");
});

test("normalizeCorrections synthesizes a stable fallback id when a record has neither id nor _id", () => {
  const out = normalizeCorrections(
    { result: [{ sentence: "a", correction: "b", reasoning: "c" }, { sentence: "d", correction: "e" }] },
    { lessonId: "L9" },
  );
  // Both would otherwise share id:null and collide/vanish in the builder's id-keyed Σ index.
  assert.equal(out[0].id, "L9#0");
  assert.equal(out[1].id, "L9#1");
});

// ── beta finding 1: a JSON serialization artifact must never reach a correction field ──

test("cleanCorrectionText strips a trailing JSON artifact and keeps the clean prose", () => {
  assert.equal(
    cleanCorrectionText("Use 'to' before the verb.}]},{\"correctionId\":\"x\""),
    "Use 'to' before the verb.",
  );
  assert.equal(cleanCorrectionText('The verb is missing."}]},{'), "The verb is missing.");
});

test("cleanCorrectionText omits a field that is entirely a JSON fragment", () => {
  assert.equal(cleanCorrectionText('[{"why":"garbage"}]'), null); // leading [{ → nothing clean
  assert.equal(cleanCorrectionText('}]},{"pattern":"x"'), null);
});

test("cleanCorrectionText returns clean text and non-strings verbatim", () => {
  assert.equal(cleanCorrectionText("A perfectly clean explanation."), "A perfectly clean explanation.");
  assert.equal(cleanCorrectionText('She said: "hello" to me'), 'She said: "hello" to me'); // ": " (spaced) is not the ":" artifact
  assert.equal(cleanCorrectionText(null), null);
  assert.equal(cleanCorrectionText(undefined), undefined);
});

test("normalizeCorrections cleans a JSON artifact out of the reasoning field", () => {
  const out = normalizeCorrections({
    result: [
      {
        sentence: "So we need work on Saturday.",
        correction: "So we need to work on Saturday.",
        reasoning: "Add 'to' before 'work'.}]},{\"correctionId\":\"y\"",
        _id: { $oid: "X1" },
      },
    ],
  });
  assert.equal(out[0].why, "Add 'to' before 'work'.");
  assert.doesNotMatch(out[0].why, /}\]},\{|":"|\[\{/);
});

// ── null-safety at the API boundary: a single poisoned member must not abort the
// whole week build (normalize failure → FETCH_FAILED run → nothing published) ──────

test("normalizeCorrections drops a null member instead of crashing", () => {
  const out = normalizeCorrections(
    { result: [{ sentence: "a", correction: "b", reasoning: "c", _id: { $oid: "X1" } }, null] },
    { lessonId: "L9" },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "X1");
});

test("normalizeTranscript skips a null turn instead of crashing", () => {
  const out = normalizeTranscript(
    { transcript: [{ text: "hi", startOffsetSeconds: 1, userId: "u1" }, null, "nope"] },
    "u1",
  );
  assert.deepEqual(out, [{ text: "hi", ts: 1, speaker: "student" }]);
});

test("normalizeChat skips a null message instead of crashing", () => {
  const out = normalizeChat({ result: [null, { message: "hi", userId: "u1" }] }, "u1");
  assert.deepEqual(out, [{ text: "hi", from: "student" }]);
});

test("normalizeLesson yields null meta but still parses content when no listing record", () => {
  const n = normalizeLesson(
    {
      lesson: {},
      lesson_transcript: { transcript: [{ text: "hello", startOffsetSeconds: 2, userId: "S" }] },
      corrective_feedback_corrections: { result: [] },
    },
    { uid: "S" },
  );
  assert.equal(n.weekId, null);
  assert.equal(n.startAtCST, null);
  assert.equal(n.minutes, null);
  assert.equal(n.transcript[0].speaker, "student");
});

// ── minutes: scheduledMinutes + start/end fallback ───────────────────────────

test("resolveMinutes reads scheduledMinutes off the lessons_v2 listing entry", () => {
  const n = normalizeLesson(
    { lesson: { id: "L", scheduledMinutes: 60, scheduledStartAt: { $date: 1783260000000 } } },
    { uid: "S" },
  );
  assert.equal(n.minutes, 60);
});

test("resolveMinutes falls back to the scheduledStartAt→scheduledEndAt span when no minutes field", () => {
  const n = normalizeLesson(
    {
      lesson: {
        id: "L",
        scheduledStartAt: { $date: 1783260000000 },
        scheduledEndAt: { $date: 1783263600000 }, // +3_600_000 ms = 60 min
      },
    },
    { uid: "S" },
  );
  assert.equal(n.minutes, 60);
});

// ── ai_tutor coaching block (WeekVM.tutorFocus source) ───────────────────────

test("normalizeAiTutorFeedback pulls the four fields through verbatim (finalAIFeedback object kept)", () => {
  const out = normalizeAiTutorFeedback({
    ai_tutor_student_feedbacks: {
      result: [
        {
          finalAIFeedback: { whatYouDidWell: "great idioms" },
          tutorNotes: "You made class fly by!",
          tutorNotesTranslated: "你让课飞快！",
          finalSuggestedNextLesson: "Maintaining Past Tense While Narrating Work Stories",
        },
      ],
    },
  });
  assert.deepEqual(out, {
    finalAIFeedback: { whatYouDidWell: "great idioms" },
    tutorNotes: "You made class fly by!",
    tutorNotesTranslated: "你让课飞快！",
    finalSuggestedNextLesson: "Maintaining Past Tense While Narrating Work Stories",
  });
});

test("normalizeAiTutorFeedback is null when the ai_tutor endpoint is absent or empty (older lessons)", () => {
  assert.equal(normalizeAiTutorFeedback({}), null);
  assert.equal(normalizeAiTutorFeedback({ ai_tutor_student_feedbacks: { result: [] } }), null);
  // Present record but every coaching field blank → nothing to surface.
  assert.equal(
    normalizeAiTutorFeedback({
      ai_tutor_student_feedbacks: { result: [{ tutorNotes: "  ", finalSuggestedNextLesson: "" }] },
    }),
    null,
  );
});

// ── real archive fixtures (gitignored, outside the repo) ─────────────────────

test(
  "normalizer transforms every real archived lesson correctly",
  { skip: realFixturesSkip() },
  () => {
    const dirs = presentLessonDirs();
    assert.ok(dirs.length > 0, "expected archived lesson dirs");
    const meta = archiveIndexByDir();
    const tutors = { result: [{ id: "t1", displayName: "Archive Tutor" }] };

    for (const dir of dirs) {
      const base = path.join(fixturesDir(), dir);
      const epoch = realEpochOf(dir);
      const row = meta[dir] || {};
      // Synthesize the missing listing record (_lesson) from real epoch + derived index meta.
      const lesson = {
        id: row.lid || dir,
        scheduledStartAt: { $date: epoch },
        durationMinutes: row.minutes,
        topic: row.topic,
        tutorId: "t1",
      };

      const n = normalizeLessonDir(base, { uid: REAL_STUDENT_UID, lesson, tutors });

      // Meta derived from real epoch
      assert.equal(n.weekId, EXPECTED_WEEK[dir], `weekId for ${dir}`);
      assert.match(n.startAtCST, /\+08:00$/);
      assert.equal(n.tutor, "Archive Tutor");
      if (row.minutes !== undefined) assert.equal(n.minutes, row.minutes);
      if (row.topic !== undefined) assert.equal(n.topic, row.topic);

      // Transcript: always an array; lines are speaker-tagged to student|tutor
      assert.ok(Array.isArray(n.transcript));
      for (const line of n.transcript) {
        assert.ok(line.speaker === "student" || line.speaker === "tutor");
        assert.equal(typeof line.text, "string");
      }

      // Corrections: lifted shape, ids present
      for (const c of n.corrections) {
        assert.ok(c.id, `correction id present in ${dir}`);
        assert.equal(typeof c.said, "string");
        assert.equal(typeof c.fix, "string");
      }

      // Stats present as numbers or null
      for (const k of ["wpm", "talkRatio", "uniqueWords"]) {
        assert.ok(n.stats[k] === null || typeof n.stats[k] === "number");
      }
    }
  },
);

test(
  "the empty-corpus lesson (0 transcript turns) normalizes to an empty transcript",
  { skip: realFixturesSkip() },
  () => {
    const dir = "2026-06-06_6a1188bc"; // TECH: 0 turns, corr 0 — the empty-corpus edge
    const dirs = presentLessonDirs();
    if (!dirs.includes(dir)) {
      // Absent in this archive snapshot — nothing to assert.
      return;
    }
    const base = path.join(fixturesDir(), dir);
    const n = normalizeLessonDir(base, {
      uid: REAL_STUDENT_UID,
      lesson: { id: dir, scheduledStartAt: { $date: realEpochOf(dir) } },
    });
    assert.deepEqual(n.transcript, []);
    assert.deepEqual(n.corrections, []);
    assert.equal(n.weekId, EXPECTED_WEEK[dir]);
  },
);

// ── recent-shape fixtures (0 corrections, scheduledMinutes, ai_tutor feedback) ─

test(
  "recent lessons normalize with minutes>0 from scheduledMinutes and a captured ai_tutor block",
  { skip: recentFixturesSkip() },
  () => {
    const dirs = presentRecentLessonDirs();
    assert.ok(dirs.length > 0, "expected recent fixture dirs");

    for (const dir of dirs) {
      // No `lesson` passed: normalizeLessonDir reads the real _lesson.json listing
      // record from the dir (mirrors how the lessons_v2 entry flows in production).
      const n = normalizeLessonDir(dir, { uid: REAL_STUDENT_UID });

      // Minutes comes from scheduledMinutes on the listing record (the whole bug 1 fix).
      assert.equal(typeof n.minutes, "number", `minutes is a number in ${dir}`);
      assert.ok(n.minutes > 0, `minutes>0 in ${dir} (got ${n.minutes})`);

      // These recent lessons carry 0 corrective corrections — the older Σ path must not
      // choke, it just yields an empty set.
      assert.deepEqual(n.corrections, [], `no corrective corrections in ${dir}`);

      // ai_tutor coaching block surfaced (bug 4 fix): all four fields present & typed,
      // finalAIFeedback kept as its raw object, the three prose fields as strings.
      assert.ok(n.aiTutorFeedback, `aiTutorFeedback present in ${dir}`);
      assert.equal(
        typeof n.aiTutorFeedback.finalAIFeedback,
        "object",
        `finalAIFeedback object in ${dir}`,
      );
      assert.notEqual(n.aiTutorFeedback.finalAIFeedback, null);
      assert.equal(typeof n.aiTutorFeedback.tutorNotes, "string", `tutorNotes in ${dir}`);
      assert.ok(n.aiTutorFeedback.tutorNotes.length > 0);
      assert.equal(
        typeof n.aiTutorFeedback.tutorNotesTranslated,
        "string",
        `tutorNotesTranslated in ${dir}`,
      );
      assert.equal(
        typeof n.aiTutorFeedback.finalSuggestedNextLesson,
        "string",
        `finalSuggestedNextLesson in ${dir}`,
      );
      assert.ok(n.aiTutorFeedback.finalSuggestedNextLesson.length > 0);
    }
  },
);

// ── mergeTurns: ASR fragments → speaker segments (spec A3) ───────────────────

const L = (speaker, text, ts) => ({ speaker, text, ts });
const words = (s) => s.split(/\s+/).filter(Boolean);
const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  if (!a.length) return 0;
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};
const wordMultiset = (lines) => words(lines.map((l) => l.text).join(" ")).sort().join("\n");

test("mergeTurns joins consecutive same-speaker lines with one space, trims each, counts them in n", () => {
  const out = mergeTurns([
    L("student", "  I went ", 1),
    L("student", "to the mountain.", 2),
    L("tutor", "That sounds lovely. What did you do there?", 3),
  ]);
  assert.deepEqual(out, [
    { speaker: "student", text: "I went to the mountain.", ts: 1, n: 2 },
    { speaker: "tutor", text: "That sounds lovely. What did you do there?", ts: 3, n: 1 },
  ]);
});

test("mergeTurns bridges a ≤3-word interjection and emits the interjection as its own segment", () => {
  const out = mergeTurns([
    L("student", "Last year on Sunday I always", 1),
    L("tutor", "Mm-hmm.", 2),
    L("student", "drive on the track to make some activity.", 3),
    L("tutor", "Very nice. Tell me more about that.", 4),
  ]);
  assert.deepEqual(
    out.map((s) => [s.speaker, s.text, s.n]),
    [
      ["student", "Last year on Sunday I always drive on the track to make some activity.", 2],
      ["tutor", "Mm-hmm.", 1],
      ["tutor", "Very nice. Tell me more about that.", 1],
    ],
  );
});

test("mergeTurns: a longer other-speaker line (> bridgeWords) ends the run", () => {
  const out = mergeTurns([L("student", "I think", 1), L("tutor", "What do you think?", 2), L("student", "it is good.", 3)]);
  assert.deepEqual(
    out.map((s) => [s.speaker, s.text]),
    [["student", "I think"], ["tutor", "What do you think?"], ["student", "it is good."]],
  );
});

test("mergeTurns bridgeWords is an inclusive limit (3 words bridge, 4 do not) and is configurable", () => {
  const lines = (interjection) => [L("student", "So we", 1), L("tutor", interjection, 2), L("student", "need to work on Saturday.", 3)];
  const studentSegs = (out) => out.filter((s) => s.speaker === "student").map((s) => s.text);

  assert.deepEqual(studentSegs(mergeTurns(lines("Yes, of course."))), ["So we need to work on Saturday."]);
  assert.deepEqual(studentSegs(mergeTurns(lines("Yes, of course, right."))), ["So we", "need to work on Saturday."]);
  assert.deepEqual(studentSegs(mergeTurns(lines("Yes, of course, right."), { bridgeWords: 4 })), ["So we need to work on Saturday."]);
});

test("mergeTurns reassembles BOTH speakers' fragments (S:for | T:Um, what | S:me, | T:about you?)", () => {
  const out = mergeTurns([L("student", "for", 1), L("tutor", "Um, what", 2), L("student", "me,", 3), L("tutor", "about you?", 4)]);
  assert.deepEqual(out, [
    { speaker: "student", text: "for me,", ts: 1, n: 2 },
    { speaker: "tutor", text: "Um, what about you?", ts: 2, n: 2 },
  ]);
});

test("mergeTurns output is ts-ordered even when a run closes after a later-starting one", () => {
  // The tutor's run spans ts 1..3 and the student's "Yes" (ts 2) sits inside it.
  const out = mergeTurns([
    L("student", "Okay", 0),
    L("tutor", "So what did you do next?", 1),
    L("student", "Yes", 2),
    L("tutor", "Tell me about the weekend please.", 3),
  ]);
  assert.deepEqual(
    out.map((s) => [s.speaker, s.ts, s.n]),
    [["student", 0, 1], ["tutor", 1, 2], ["student", 2, 1]],
  );
});

test("mergeTurns loses no text: the word multiset is preserved and blank lines are dropped", () => {
  const lines = [
    L("student", "I go to", 1),
    L("tutor", "   ", 1.5),
    L("tutor", "uh", 2),
    L("student", "the mountain with my family.", 3),
    L("tutor", "", 3.5),
    L("tutor", "That sounds lovely. What did you do there?", 4),
  ];
  const out = mergeTurns(lines);
  assert.equal(wordMultiset(out), wordMultiset(lines));
  assert.equal(out.reduce((n, s) => n + s.n, 0), 4, "blank lines are not counted as merged lines");
  assert.ok(out.every((s) => s.text.trim() !== ""));
});

test("mergeTurns keeps input order when a line lacks a ts, and tolerates empty or non-array input", () => {
  const out = mergeTurns([L("tutor", "Hello there, how are you today?", null), L("student", "Fine", 5)]);
  assert.deepEqual(out.map((s) => [s.speaker, s.ts]), [["tutor", null], ["student", 5]]);
  assert.deepEqual(mergeTurns([]), []);
  assert.deepEqual(mergeTurns(null), []);
  assert.deepEqual(mergeTurns([null, L("student", "hi", 1)]), [{ speaker: "student", text: "hi", ts: 1, n: 1 }]);
});

test("mergeTurns is pure: the input lines are not mutated", () => {
  const lines = [L("student", " a ", 1), L("student", "b", 2)];
  const copy = JSON.parse(JSON.stringify(lines));
  mergeTurns(lines);
  assert.deepEqual(lines, copy);
});

test("normalizeLesson sets segments from the transcript and leaves transcript as-is", () => {
  const n = normalizeLessonDir(SYNTH_DIR, { uid: SYNTH_UID });
  // Every synthetic line is ≥ 6 words, so nothing bridges: one segment per line, verbatim.
  assert.equal(n.transcript.length, 6);
  assert.deepEqual(
    n.segments,
    n.transcript.map((t) => ({ speaker: t.speaker, text: t.text, ts: t.ts, n: 1 })),
  );
});

test(
  "mergeTurns on the recent fixtures: substantive student segments median ≥ 12 words, no text lost, ts-ordered",
  { skip: recentFixturesSkip() },
  () => {
    for (const dir of presentRecentLessonDirs()) {
      const n = normalizeLessonDir(dir, { uid: REAL_STUDENT_UID });
      // No text lost.
      assert.equal(wordMultiset(n.segments), wordMultiset(n.transcript), `word multiset preserved in ${dir}`);
      // Stable ts order.
      for (let i = 1; i < n.segments.length; i++) {
        assert.ok(n.segments[i - 1].ts <= n.segments[i].ts, `segments ts-ordered in ${dir}`);
      }
      // Merging happened: the ASR chops the student's median line to ~2 words …
      const rawStudent = n.transcript.filter((t) => t.speaker === "student").map((t) => words(t.text).length);
      const segStudent = n.segments.filter((s) => s.speaker === "student").map((s) => words(s.text).length);
      assert.ok(segStudent.length < rawStudent.length, `fewer student segments than raw lines in ${dir}`);
      assert.ok(median(rawStudent) <= 3, `raw student lines are fragments in ${dir}`);
      // … and the student's SUBSTANTIVE segments (everything beyond a ≤3-word backchannel,
      // which the rule deliberately keeps as its own segment) read as whole utterances.
      const substantive = segStudent.filter((w) => w > 3);
      assert.ok(median(substantive) >= 12, `median substantive student words ≥ 12 in ${dir} (got ${median(substantive)})`);
    }
  },
);

// ── tutors map (spec A1): {id: {id, displayName}} from either endpoint shape ──

test("normalizeTutors flattens the live object-map payload {result: {id: record}}", () => {
  const map = normalizeTutors({ result: { t1: { id: "t1", displayName: "Alex R.", country: "US", rating: 4.9 } } });
  assert.deepEqual(map, { t1: { id: "t1", displayName: "Alex R." } });
});

test("normalizeTutors flattens the array payload, keying by id or _id.$oid and deriving the name", () => {
  const map = normalizeTutors({
    result: [
      { id: "a", displayName: "Sam Rivers", firstName: "Sam", lastName: "Rivers" },
      { _id: { $oid: "b" }, name: "Bea" },
      { id: "c", firstName: "Cy", lastName: "Do" },
      { id: "d" }, // no resolvable name → dropped
      null,
    ],
  });
  assert.deepEqual(map, {
    a: { id: "a", displayName: "Sam Rivers" },
    b: { id: "b", displayName: "Bea" },
    c: { id: "c", displayName: "Cy Do" },
  });
});

test("normalizeTutors accepts an already-flat map (string values too) and yields {} for nothing usable", () => {
  assert.deepEqual(normalizeTutors({ t1: "Alex R." }), { t1: { id: "t1", displayName: "Alex R." } });
  assert.deepEqual(normalizeTutors({ t1: { id: "t1", displayName: "Alex R." } }), { t1: { id: "t1", displayName: "Alex R." } });
  assert.deepEqual(normalizeTutors(undefined), {});
  assert.deepEqual(normalizeTutors({ result: [] }), {});
  assert.deepEqual(normalizeTutors({ __status: 500 }), {}); // a dead-endpoint stub
});

test("mergeTutors never shrinks: ids from both sides survive and the newer name wins", () => {
  const prev = { a: { id: "a", displayName: "Old A" }, b: { id: "b", displayName: "B" } };
  const next = { result: { a: { id: "a", displayName: "New A" }, c: { id: "c", displayName: "C" } } };
  const merged = mergeTutors(prev, next);
  assert.deepEqual(merged, {
    a: { id: "a", displayName: "New A" },
    b: { id: "b", displayName: "B" },
    c: { id: "c", displayName: "C" },
  });
  assert.deepEqual(prev, { a: { id: "a", displayName: "Old A" }, b: { id: "b", displayName: "B" } }, "inputs not mutated");
  assert.deepEqual(mergeTutors(prev, undefined), prev);
});

test("tutorDisplayName / lessonTutorId resolve the name and id fields in priority order", () => {
  assert.equal(tutorDisplayName({ displayName: "D", name: "N" }), "D");
  assert.equal(tutorDisplayName({ name: "N", firstName: "F" }), "N");
  assert.equal(tutorDisplayName({ firstName: "F", lastName: "L" }), "F L");
  assert.equal(tutorDisplayName({ firstName: "F" }), "F");
  assert.equal(tutorDisplayName({ displayName: "  " }), null);
  assert.equal(tutorDisplayName("Plain"), "Plain");
  assert.equal(tutorDisplayName(null), null);
  assert.equal(lessonTutorId({ tutorId: "x", tutorIds: ["y"] }), "x");
  assert.equal(lessonTutorId({ tutorIds: ["y"] }), "y");
  assert.equal(lessonTutorId({}), null);
  assert.equal(lessonTutorId(null), null);
});

test("normalizeLesson resolves the tutor through the raw tutors.json shape {result: <object map>}", () => {
  const n = normalizeLesson(
    { lesson: { id: "L", tutorIds: ["t9"] }, tutors: { result: { t9: { id: "t9", displayName: "Alex R." } } } },
    { uid: "S" },
  );
  assert.equal(n.tutor, "Alex R.");
});

test("normalizeLesson falls back to lesson.tutorName (else null) when the tutor is not in the map", () => {
  const withName = normalizeLesson({ lesson: { id: "L", tutorId: "zz", tutorName: "Listed" }, tutors: { result: {} } }, { uid: "S" });
  assert.equal(withName.tutor, "Listed");
  const none = normalizeLesson({ lesson: { id: "L", tutorId: "zz" }, tutors: { result: [] } }, { uid: "S" });
  assert.equal(none.tutor, null);
});

test("normalizeLessonDir merges a passed tutors map OVER the dir's own tutors.json", () => {
  // The synthetic dir's tutors.json knows tutor999 as "Sam Rivers".
  const renamed = normalizeLessonDir(SYNTH_DIR, { uid: SYNTH_UID, tutors: { tutor999: { id: "tutor999", displayName: "Sam R." } } });
  assert.equal(renamed.tutor, "Sam R.");
  // A passed map for a DIFFERENT tutor leaves the dir's own entry resolvable.
  const kept = normalizeLessonDir(SYNTH_DIR, { uid: SYNTH_UID, tutors: { other: { id: "other", displayName: "X" } } });
  assert.equal(kept.tutor, "Sam Rivers");
});

test("ENDPOINT_FILES is the single raw-file catalog shared with run.js", () => {
  assert.equal(Object.keys(ENDPOINT_FILES).length, 9);
  assert.equal(ENDPOINT_FILES.lesson_transcript, "lesson_transcript.json");
  assert.equal(ENDPOINT_FILES.corrective_feedback_corrections, "corrective_feedback_corrections.json");
});
