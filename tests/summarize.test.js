// tests/summarize.test.js — summarizer vs a mocked OpenAI (TECH §3, §9 I-SM ①③④⑥).
//
// The OpenAI host is exercised through the real OPENAI_BASE_URL env seam: a node:http
// server on 127.0.0.1 stands in for api.openai.com. No network, no clock, no sleeps
// (retry backoff is injected as 0 ms).

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  wireSchema,
  acceptanceSchema,
  validateAgainstSchema,
  buildRequestBody,
  buildWeekBundle,
  summarizeWeek,
  OpenAIError,
  SchemaInvalidError,
  RULES,
} from "../src/summarize.js";
import { BANDS, LEVEL_DIMENSIONS, CONFIDENCE_LEVELS, PLAN_DAYS } from "../src/coach.js";

const FAST = { sleep: async () => {}, backoff: [0, 0, 0] };

/** The five canonical level dimensions, all at one band. */
function dims(band = "B1+") {
  return LEVEL_DIMENSIONS.map((name) => ({ name, band, evidence: `${name} evidence` }));
}

/**
 * A minimal, valid recap-v2 wire object: one class (with title), one vocab (with a null
 * example), one grammar group holding one Cambly-anchored AND one transcript-derived item,
 * one phrasing, one practice, plus review / level / plan.
 */
function validWire() {
  return {
    classes: [
      { lessonId: "L1", title: "Weekend hike & coffee", moment: { text: "You said “I went there.”", quotes: ["I went there."] }, tutorNote: "Great work" },
    ],
    vocabulary: [
      { term: "picnic", meaning: "outdoor meal", quote: "we had a picnic", quoteBy: "student", lessonId: "L1", fromCorrectionId: null, example: null },
    ],
    grammarGroups: [
      {
        pattern: "Past tense",
        rule: "Use past for finished actions.",
        items: [
          { correctionId: "c1", said: null, fix: null, why: "finished", lessonId: null }, // Cambly-anchored
          { correctionId: null, said: "I go there yesterday", fix: "I went there yesterday", why: "finished action", lessonId: "L1" }, // derived
        ],
      },
    ],
    phrasing: [
      { said: "I go there", better: "I went there", why: "past", lessonId: "L1", fromCorrectionId: null },
    ],
    practice: [
      { format: "CORRECT_IT", prompt: "I ____ there.", cue: null, answer: "**went**", why: "past", sourceIds: ["c1"] },
    ],
    review: {
      summary: "A steady week of past-tense narration.",
      wentWell: [{ point: "Long turns", quote: "I went there.", lessonId: "L1" }],
      needsWork: [{ issue: "Past tense under pressure", fix: "Use -ed on every finished action.", quote: null, lessonId: null }],
    },
    level: {
      overall: "B1+",
      confidence: "medium",
      dimensions: dims("B1+"),
      summary: "Long turns with systematic slips.",
      advice: [{ title: "Past tense drill", detail: "Retell yesterday for two minutes." }],
    },
    plan: {
      focus: "Past tense on every finished action.",
      items: [{ day: "Mon", task: "Retell your weekend.", why: "Past narration slipped." }, { day: "Daily", task: "One past-tense story.", why: "" }],
      askTutor: ["Ask for a stop on every present-for-past slip."],
    },
  };
}

/** The pre-v2 wire shape (no review/level/plan, no title/example, grammar items = correctionId + why). */
function legacyWire() {
  return {
    classes: [{ lessonId: "L1", moment: { text: "You said “I went there.”", quotes: ["I went there."] }, tutorNote: null }],
    vocabulary: [{ term: "picnic", meaning: "outdoor meal", quote: "we had a picnic", quoteBy: "student", lessonId: "L1", fromCorrectionId: null }],
    grammarGroups: [{ pattern: "Past tense", rule: null, items: [{ correctionId: "c1", why: "finished" }] }],
    phrasing: [],
    practice: [],
  };
}

function completionEnvelope(wire, { promptTokens = 4321 } = {}) {
  return JSON.stringify({
    id: "chatcmpl-mock",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(wire) } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: 10 },
  });
}

/** Start a mock OpenAI server. `handler(callIndex, reqBody) => { status, body }`. */
async function startMock(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const idx = requests.length;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      const { status = 200, body = "" } = handler(idx, raw) || {};
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}

// ── Wire schema shape — the LLM-owned fields ONLY (I-SM ①) ────────────────────

test("I-SM① the wire schema is strict and requests ONLY the LLM-owned fields", () => {
  const body = buildRequestBody({ bundle: "…", model: "gpt-x" });
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.response_format.json_schema.name, "weekly_recap");
  assert.equal(body.model, "gpt-x");

  const schema = body.response_format.json_schema.schema;
  const topKeys = ["classes", "grammarGroups", "level", "phrasing", "plan", "practice", "review", "vocabulary"];
  assert.deepEqual(Object.keys(schema.properties).sort(), topKeys);
  assert.deepEqual([...schema.required].sort(), topKeys, "strict: every top-level block is required");
  assert.equal(schema.additionalProperties, false);

  // Classes carry the LLM title but NO builder-derived scalars (no minutes/stats/topic/tutor/startAt).
  const classProps = Object.keys(schema.properties.classes.items.properties).sort();
  assert.deepEqual(classProps, ["lessonId", "moment", "title", "tutorNote"]);

  // Grammar items: correctionId + why, plus the nullable derived-item trio said/fix/lessonId.
  const grammarItem = schema.properties.grammarGroups.items.properties.items.items;
  assert.deepEqual(Object.keys(grammarItem.properties).sort(), ["correctionId", "fix", "lessonId", "said", "why"]);
  for (const k of ["correctionId", "said", "fix", "lessonId"]) {
    assert.deepEqual(grammarItem.properties[k].type, ["string", "null"], `${k} is nullable`);
  }
  assert.equal(grammarItem.properties.why.type, "string");

  // Vocabulary/phrasing carry the FK + nullable fromCorrectionId but no id (builder fills id).
  assert.ok(!("id" in schema.properties.vocabulary.items.properties));
  assert.ok(!("id" in schema.properties.phrasing.items.properties));
  assert.deepEqual(schema.properties.vocabulary.items.properties.example.type, ["string", "null"]);
});

test("I-SM① the v2 blocks use the closed vocabularies and carry no builder-owned fields", () => {
  const schema = wireSchema();
  const level = schema.properties.level;
  assert.deepEqual(level.properties.overall.enum, [...BANDS]);
  assert.deepEqual(level.properties.confidence.enum, [...CONFIDENCE_LEVELS]);
  assert.deepEqual(level.properties.dimensions.items.properties.name.enum, [...LEVEL_DIMENSIONS]);
  assert.deepEqual(level.properties.dimensions.items.properties.band.enum, [...BANDS]);
  assert.ok(!("bandIndex" in level.properties), "bandIndex is builder-derived");
  assert.ok(!("bandIndex" in level.properties.dimensions.items.properties));
  const plan = schema.properties.plan;
  assert.deepEqual(plan.properties.items.items.properties.day.enum, [...PLAN_DAYS]);
  assert.ok(!("weekLabel" in plan.properties), "plan.weekLabel is builder-derived");
  const review = schema.properties.review;
  assert.deepEqual(review.properties.wentWell.items.properties.quote.type, ["string", "null"]);
  assert.deepEqual(review.properties.needsWork.items.properties.quote.type, ["string", "null"]);
  // Every nested object is strict too.
  assert.equal(level.additionalProperties, false);
  assert.equal(plan.properties.items.items.additionalProperties, false);
  assert.equal(review.properties.needsWork.items.additionalProperties, false);
});

test("wireSchema returns a fresh object each call (a caller cannot mutate the shared schema)", () => {
  const a = wireSchema();
  a.required.length = 0;
  assert.equal(wireSchema().required.length, 8);
});

test("the system RULES prompt states the verbatim-quote and place-once contracts", () => {
  assert.match(RULES, /character-for-character/);
  assert.match(RULES, /EXACTLY ONCE/);
  assert.match(RULES, /exactly 8 practice/);
  // beta finding 3: grammar groups get a readable human title, not a slug/punctuation.
  assert.match(RULES, /human-readable title/);
  // beta finding 5: the vocab example quote must actually contain the term (a real usage).
  assert.match(RULES, /actually CONTAINS the term/);
});

test("the system RULES prompt carries the v2 rules 6–12 (transcript grammar, phrasing cap, example, review, CEFR level, plan, titles)", () => {
  assert.match(RULES, /6\. Grammar from the transcript/);
  assert.match(RULES, /correctionId null; lessonId set/);
  assert.match(RULES, /7\. Phrasing: at most 8 items/);
  assert.match(RULES, /8\. Vocabulary: 6–10 items/);
  assert.match(RULES, /ALSO give example/);
  assert.match(RULES, /9\. Review: summary = 3–5 sentences/);
  assert.match(RULES, /10\. Level \(CEFR\): judge SPONTANEOUS speech only/);
  assert.match(RULES, /range, accuracy,\s+fluency, interaction, coherence/);
  assert.match(RULES, /11\. Plan: a concrete 7-day plan for the week AFTER this one/);
  assert.match(RULES, /12\. Titles: classes\[\]\.title/);
  assert.match(RULES, /never "Pro Lesson"/);
});

// ── validateAgainstSchema ─────────────────────────────────────────────────────

test("validateAgainstSchema accepts a valid wire and rejects violations", () => {
  assert.deepEqual(validateAgainstSchema(validWire(), wireSchema()), []);

  const missing = validWire();
  delete missing.vocabulary[0].quote;
  assert.ok(validateAgainstSchema(missing, wireSchema()).some((e) => e.includes("quote")));

  const wrongType = validWire();
  wrongType.classes[0].moment.quotes = "not-an-array";
  assert.ok(validateAgainstSchema(wrongType, wireSchema()).length > 0);

  const badEnum = validWire();
  badEnum.practice[0].format = "MYSTERY";
  assert.ok(validateAgainstSchema(badEnum, wireSchema()).some((e) => e.includes("enum")));

  const extra = validWire();
  extra.classes[0].minutes = 30; // builder-owned field must not appear
  assert.ok(validateAgainstSchema(extra, wireSchema()).some((e) => e.includes("additional property")));

  const nullNote = validWire();
  nullNote.classes[0].tutorNote = null; // nullable union is allowed
  assert.deepEqual(validateAgainstSchema(nullNote, wireSchema()), []);
});

test("validateAgainstSchema (strict): v2 nullables are accepted, bad band / day / dimension enums and a missing block are rejected", () => {
  const nulls = validWire();
  nulls.vocabulary[0].example = null;
  nulls.review.wentWell[0].quote = null;
  nulls.review.wentWell[0].lessonId = null;
  assert.deepEqual(validateAgainstSchema(nulls, wireSchema()), []);

  const badBand = validWire();
  badBand.level.overall = "Z9";
  assert.ok(validateAgainstSchema(badBand, wireSchema()).some((e) => e.includes("level.overall") && e.includes("enum")));

  const badDay = validWire();
  badDay.plan.items[0].day = "Funday";
  assert.ok(validateAgainstSchema(badDay, wireSchema()).some((e) => e.includes("plan.items[0].day")));

  const badDim = validWire();
  badDim.level.dimensions[0].name = "spelling";
  assert.ok(validateAgainstSchema(badDim, wireSchema()).some((e) => e.includes("dimensions[0].name")));

  const noReview = validWire();
  delete noReview.review;
  assert.ok(validateAgainstSchema(noReview, wireSchema()).some((e) => e.includes("review: required")));

  const derivedMissingLesson = validWire();
  delete derivedMissingLesson.grammarGroups[0].items[1].lessonId;
  assert.ok(validateAgainstSchema(derivedMissingLesson, wireSchema()).some((e) => e.includes("lessonId: required")));
});

test("acceptanceSchema relaxes ONLY the v2 additions: a legacy-shaped wire passes it but not the strict schema; types/enums/extras still fail", () => {
  const legacy = legacyWire();
  assert.ok(validateAgainstSchema(legacy, wireSchema()).length > 0, "strict request schema rejects the legacy shape");
  assert.deepEqual(validateAgainstSchema(legacy, acceptanceSchema()), [], "acceptance schema tolerates it");
  assert.deepEqual(validateAgainstSchema(validWire(), acceptanceSchema()), [], "the full v2 wire passes too");

  const extra = legacyWire();
  extra.classes[0].minutes = 30;
  assert.ok(validateAgainstSchema(extra, acceptanceSchema()).some((e) => e.includes("additional property")));

  const badBand = validWire();
  badBand.level.overall = "Z9";
  assert.ok(validateAgainstSchema(badBand, acceptanceSchema()).some((e) => e.includes("enum")));

  const noPractice = legacyWire();
  delete noPractice.practice; // a legacy-required block is still required
  assert.ok(validateAgainstSchema(noPractice, acceptanceSchema()).some((e) => e.includes("practice: required")));

  // The request body still carries the STRICT schema — acceptance is local only.
  const sent = buildRequestBody({ bundle: "…" }).response_format.json_schema.schema;
  assert.ok(sent.required.includes("review") && sent.required.includes("level") && sent.required.includes("plan"));
});

// ── buildWeekBundle ───────────────────────────────────────────────────────────

function bundleLesson(over = {}) {
  return {
    lessonId: "L1", weekday: "Wed", startAtCST: "2026-05-13T10:30:00+08:00", minutes: 30,
    tutor: "Sam", topic: "Weekend",
    stats: { wpm: 68, talkRatio: 47, uniqueWords: 132 },
    transcript: [{ text: "Hi there", speaker: "tutor" }, { text: "I go home", speaker: "student" }],
    corrections: [{ id: "c1", said: "I go home", fix: "I went home", why: "past" }],
    tutorNotes: ["Nice job"], chat: [{ text: "went", from: "tutor" }],
    ...over,
  };
}

test("buildWeekBundle emits per-lesson meta, numbered speaker turns, and correction ids", () => {
  const bundle = buildWeekBundle([bundleLesson()]);
  assert.match(bundle, /lessonId: L1/);
  assert.match(bundle, /\[1\] \(tutor\) Hi there/);
  assert.match(bundle, /\[2\] \(student\) I go home/);
  assert.match(bundle, /c1 · "I go home" -> "I went home"/);
  assert.match(bundle, /Nice job/);
});

test("buildWeekBundle opens with the week header (label · class count · tutors) and the read-aloud note", () => {
  const bundle = buildWeekBundle([bundleLesson()]);
  // The label is derived from the first lesson's week when the caller passes none.
  assert.ok(bundle.startsWith("## Week of May 11–17 — 1 class · tutors: Sam\n"), `header: ${bundle.split("\n")[0]}`);
  assert.match(bundle, /"Pro Lesson" classes the student READS AN ARTICLE ALOUD/);
  // An explicit label wins; two tutors are listed once each; a nameless week says "unknown".
  const two = buildWeekBundle(
    [bundleLesson(), bundleLesson({ lessonId: "L2", startAtCST: "2026-05-15T10:30:00+08:00", tutor: "Niki V." }), bundleLesson({ lessonId: "L3", startAtCST: "2026-05-16T10:30:00+08:00" })],
    { weekLabel: "Custom label" },
  );
  assert.ok(two.startsWith("## Week of Custom label — 3 classes · tutors: Sam, Niki V.\n"));
  const nameless = buildWeekBundle([bundleLesson({ tutor: "" })]);
  assert.match(nameless, /tutors: unknown/);
});

test("buildWeekBundle meta line carries the Cambly stats (wpm · talk% · unique words), ? when absent", () => {
  assert.match(buildWeekBundle([bundleLesson()]), /lessonId: L1 · 68 wpm · 47% talk · 132 unique words/);
  assert.match(buildWeekBundle([bundleLesson({ stats: { wpm: null, talkRatio: null, uniqueWords: null } })]), /\? wpm · \?% talk · \? unique words/);
});

test("buildWeekBundle lists merged `segments` when present (transcript fallback otherwise)", () => {
  const merged = bundleLesson({
    transcript: [{ text: "I go", speaker: "student" }, { text: "Yeah.", speaker: "tutor" }, { text: "home and I sleep", speaker: "student" }],
    segments: [{ speaker: "student", text: "I go home and I sleep", ts: 0, n: 2 }, { speaker: "tutor", text: "Yeah.", ts: 1, n: 1 }],
  });
  const bundle = buildWeekBundle([merged]);
  assert.match(bundle, /\[1\] \(student\) I go home and I sleep/);
  assert.match(bundle, /\[2\] \(tutor\) Yeah\./);
  assert.ok(!/\(student\) I go\n/.test(bundle), "raw fragments are not listed when segments exist");
  // No segments → the raw transcript is listed (legacy normalized lessons).
  assert.match(buildWeekBundle([bundleLesson()]), /\[2\] \(student\) I go home/);
  // An empty transcript reads (none) instead of nothing.
  assert.match(buildWeekBundle([bundleLesson({ transcript: [] })]), /Transcript:\n  \(none\)/);
});

test("buildWeekBundle appends the four Cambly coach lines per class — strict worksheet strip on work-on / practice ideas", () => {
  const withCoach = bundleLesson({
    aiTutorFeedback: {
      finalAIFeedback: {
        whatYouDidWell: "🎉 Nice retention of the new phrasal verbs.",
        whatWeCanWorkOn: "💻☕ Tech & Daily Work Small Talk\n🌟 Useful Vocabulary\nGlitch – a small technical problem", // a pasted worksheet → (none)
        ideasForPractice: "Retell your workday in the past tense.\n\nExercise 1: Choose the Correct Verb\n→ ______", // prose kept, drill cut
      },
      tutorNotes: null,
      tutorNotesTranslated: null,
      finalSuggestedNextLesson: "Past tense narration at work",
    },
  });
  const bundle = buildWeekBundle([withCoach]);
  assert.match(bundle, /Cambly coach — what went well: 🎉 Nice retention of the new phrasal verbs\./);
  assert.match(bundle, /Cambly coach — work on: \(none\)/);
  assert.match(bundle, /Cambly coach — practice ideas: Retell your workday in the past tense\.\n/);
  assert.ok(!/Choose the Correct Verb/.test(bundle), "the drill tail never reaches the LLM");
  assert.match(bundle, /Tutor's suggested next lesson: Past tense narration at work/);
  // The coach lines follow the Chat block of the same class.
  assert.ok(bundle.indexOf("Chat:") < bundle.indexOf("Cambly coach — what went well"));
  // A lesson without ai_tutor feedback (older shape) says (none) four times.
  const none = buildWeekBundle([bundleLesson()]);
  assert.equal((none.match(/Cambly coach — .*: \(none\)/g) || []).length, 3);
  assert.match(none, /Tutor's suggested next lesson: \(none\)/);
});

test("buildWeekBundle orders lessons chronologically", () => {
  const late = { lessonId: "B", startAtCST: "2026-05-15T09:00:00+08:00", weekday: "Fri", minutes: 30, tutor: "T", topic: "X", transcript: [], corrections: [], tutorNotes: [], chat: [] };
  const early = { lessonId: "A", startAtCST: "2026-05-13T09:00:00+08:00", weekday: "Wed", minutes: 30, tutor: "T", topic: "X", transcript: [], corrections: [], tutorNotes: [], chat: [] };
  const bundle = buildWeekBundle([late, early]);
  assert.ok(bundle.indexOf("lessonId: A") < bundle.indexOf("lessonId: B"));
});

// ── summarizeWeek over the OPENAI_BASE_URL seam ───────────────────────────────

test("summarizeWeek POSTs the strict request to /v1/chat/completions and returns the wire", async () => {
  const mock = await startMock(() => ({ status: 200, body: completionEnvelope(validWire(), { promptTokens: 999 }) }));
  try {
    const out = await summarizeWeek({ bundle: "BUNDLE", model: "gpt-5.1", base: mock.base, apiKey: "sk-test", ...FAST });
    assert.deepEqual(out.wire, validWire());
    assert.equal(out.promptTokens, 999);
    assert.equal(out.model, "gpt-5.1");

    assert.equal(mock.requests.length, 1);
    const req = mock.requests[0];
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer sk-test");
    const sent = JSON.parse(req.body);
    assert.equal(sent.response_format.json_schema.strict, true);
    assert.equal(sent.messages[0].role, "system");
    assert.equal(sent.messages[1].content, "BUNDLE");
  } finally {
    await mock.close();
  }
});

test("I-SM③ schema-invalid response is retried 3× then throws SchemaInvalidError", async () => {
  const badWire = { classes: [], vocabulary: [], grammarGroups: [], phrasing: [] }; // missing 'practice'
  const mock = await startMock(() => ({ status: 200, body: completionEnvelope(badWire) }));
  try {
    await assert.rejects(
      () => summarizeWeek({ bundle: "B", base: mock.base, retries: 3, ...FAST }),
      (e) => e instanceof SchemaInvalidError && e.stage === "summarize",
    );
    assert.equal(mock.requests.length, 3);
  } finally {
    await mock.close();
  }
});

test("I-SM⑥ transport 5xx is retried 3× then throws OpenAIError", async () => {
  const mock = await startMock(() => ({ status: 503, body: "{}" }));
  try {
    await assert.rejects(
      () => summarizeWeek({ bundle: "B", base: mock.base, retries: 3, ...FAST }),
      (e) => e instanceof OpenAIError && e.status === 503,
    );
    assert.equal(mock.requests.length, 3);
  } finally {
    await mock.close();
  }
});

test("a non-transient 400 fails immediately without retry", async () => {
  const mock = await startMock(() => ({ status: 400, body: '{"error":"bad request"}' }));
  try {
    await assert.rejects(
      () => summarizeWeek({ bundle: "B", base: mock.base, retries: 3, ...FAST }),
      (e) => e instanceof OpenAIError && e.status === 400,
    );
    assert.equal(mock.requests.length, 1);
  } finally {
    await mock.close();
  }
});

// A 429 is two different failures wearing one status code. `insufficient_quota`
// means the OpenAI account has no credit left — no number of retries clears it,
// and reporting it as a bare "OpenAI HTTP 429" reads as a rate limit, which is
// what hid a four-service billing outage on 2026-07-26.
test("a 429 insufficient_quota fails immediately and names the billing cause", async () => {
  const body = JSON.stringify({
    error: {
      message: "You exceeded your current quota, please check your plan and billing details.",
      type: "insufficient_quota",
      code: "insufficient_quota",
    },
  });
  const mock = await startMock(() => ({ status: 429, body }));
  try {
    await assert.rejects(
      () => summarizeWeek({ bundle: "B", base: mock.base, retries: 3, ...FAST }),
      (e) =>
        e instanceof OpenAIError &&
        e.status === 429 &&
        /insufficient_quota/.test(e.message) &&
        /credit|billing/i.test(e.message),
    );
    assert.equal(mock.requests.length, 1, "quota exhaustion must not be retried");
  } finally {
    await mock.close();
  }
});

test("a genuine rate-limit 429 is still transient and retried 3×", async () => {
  const body = JSON.stringify({
    error: { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" },
  });
  const mock = await startMock(() => ({ status: 429, body }));
  try {
    await assert.rejects(
      () => summarizeWeek({ bundle: "B", base: mock.base, retries: 3, ...FAST }),
      (e) => e instanceof OpenAIError && e.status === 429 && !/insufficient_quota/.test(e.message),
    );
    assert.equal(mock.requests.length, 3);
  } finally {
    await mock.close();
  }
});

test("a 429 with an unparseable body stays transient (fails safe toward retry)", async () => {
  const mock = await startMock(() => ({ status: 429, body: "<html>gateway</html>" }));
  try {
    await assert.rejects(
      () => summarizeWeek({ bundle: "B", base: mock.base, retries: 3, ...FAST }),
      (e) => e instanceof OpenAIError && e.status === 429,
    );
    assert.equal(mock.requests.length, 3);
  } finally {
    await mock.close();
  }
});

test("summarizeWeek accepts a legacy-shaped wire (no review/level/plan) through the acceptance schema", async () => {
  const mock = await startMock(() => ({ status: 200, body: completionEnvelope(legacyWire()) }));
  try {
    const out = await summarizeWeek({ bundle: "B", base: mock.base, retries: 1, ...FAST });
    assert.deepEqual(out.wire, legacyWire());
    assert.equal(mock.requests.length, 1);
  } finally {
    await mock.close();
  }
});

test("summarizeWeek recovers when a 500 is followed by a 200", async () => {
  const mock = await startMock((i) => (i === 0 ? { status: 500, body: "{}" } : { status: 200, body: completionEnvelope(validWire()) }));
  try {
    const out = await summarizeWeek({ bundle: "B", base: mock.base, retries: 3, ...FAST });
    assert.deepEqual(out.wire, validWire());
    assert.equal(mock.requests.length, 2);
  } finally {
    await mock.close();
  }
});

test("unparseable model content is treated as schema-invalid and retried", async () => {
  const garbage = JSON.stringify({ choices: [{ message: { content: "not json {" } }], usage: {} });
  const mock = await startMock(() => ({ status: 200, body: garbage }));
  try {
    await assert.rejects(
      () => summarizeWeek({ bundle: "B", base: mock.base, retries: 3, ...FAST }),
      SchemaInvalidError,
    );
    assert.equal(mock.requests.length, 3);
  } finally {
    await mock.close();
  }
});
