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
  validateAgainstSchema,
  buildRequestBody,
  buildWeekBundle,
  summarizeWeek,
  OpenAIError,
  SchemaInvalidError,
  RULES,
} from "../src/summarize.js";

const FAST = { sleep: async () => {}, backoff: [0, 0, 0] };

/** A minimal, valid wire object (one class, one vocab, one grammar item, one phrasing, one practice). */
function validWire() {
  return {
    classes: [
      { lessonId: "L1", moment: { text: "You said “I went there.”", quotes: ["I went there."] }, tutorNote: "Great work" },
    ],
    vocabulary: [
      { term: "picnic", meaning: "outdoor meal", quote: "we had a picnic", quoteBy: "student", lessonId: "L1", fromCorrectionId: null },
    ],
    grammarGroups: [
      { pattern: "Past tense", rule: "Use past for finished actions.", items: [{ correctionId: "c1", why: "finished" }] },
    ],
    phrasing: [
      { said: "I go there", better: "I went there", why: "past", lessonId: "L1", fromCorrectionId: null },
    ],
    practice: [
      { format: "CORRECT_IT", prompt: "I ____ there.", cue: null, answer: "**went**", why: "past", sourceIds: ["c1"] },
    ],
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
  assert.deepEqual(Object.keys(schema.properties).sort(), ["classes", "grammarGroups", "phrasing", "practice", "vocabulary"]);
  assert.equal(schema.additionalProperties, false);

  // Classes carry NO builder-derived scalars (no minutes/stats/topic/tutor/startAt).
  const classProps = Object.keys(schema.properties.classes.items.properties).sort();
  assert.deepEqual(classProps, ["lessonId", "moment", "tutorNote"]);

  // Grammar items expose only correctionId + why — never said/fix (structurally unhallucinable).
  const grammarItemProps = Object.keys(schema.properties.grammarGroups.items.properties.items.items.properties).sort();
  assert.deepEqual(grammarItemProps, ["correctionId", "why"]);

  // Vocabulary/phrasing carry the FK + nullable fromCorrectionId but no id (builder fills id).
  assert.ok(!("id" in schema.properties.vocabulary.items.properties));
  assert.ok(!("id" in schema.properties.phrasing.items.properties));
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

// ── buildWeekBundle ───────────────────────────────────────────────────────────

test("buildWeekBundle emits per-lesson meta, numbered speaker turns, and correction ids", () => {
  const lessons = [
    {
      lessonId: "L1", weekday: "Wed", startAtCST: "2026-05-13T10:30:00+08:00", minutes: 30,
      tutor: "Sam", topic: "Weekend",
      transcript: [{ text: "Hi there", speaker: "tutor" }, { text: "I go home", speaker: "student" }],
      corrections: [{ id: "c1", said: "I go home", fix: "I went home", why: "past" }],
      tutorNotes: ["Nice job"], chat: [{ text: "went", from: "tutor" }],
    },
  ];
  const bundle = buildWeekBundle(lessons);
  assert.match(bundle, /lessonId: L1/);
  assert.match(bundle, /\[1\] \(tutor\) Hi there/);
  assert.match(bundle, /\[2\] \(student\) I go home/);
  assert.match(bundle, /c1 · "I go home" -> "I went home"/);
  assert.match(bundle, /Nice job/);
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
