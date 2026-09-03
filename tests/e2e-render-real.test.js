// tests/e2e-render-real.test.js — Stage-4 QA: the WHOLE fixed pipeline end-to-end,
// all the way to the emitted week HTML.
//
// build.test.js proves the real-fixture VM is correct; this suite is the missing
// RENDER-PATH assertion: real archived lessons → generateWeekVM (OpenAI mocked over
// HTTP, exactly like production transport) → the fail-closed render gates
// (validateWeek · assertSigma · assertBudget) → renderWeek → assertions on the
// actual HTML string a reader would receive. Fixtures live OUTSIDE the repo and are
// read at runtime (never copied in); the suite skips cleanly from a bare clone.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";

import { weekWindow } from "../src/week.js";
import { normalizeLessonDir } from "../src/normalize.js";
import { generateWeekVM } from "../src/build.js";
import { renderWeek } from "../src/render/week.js";
import {
  validateWeek,
  assertSigma,
  assertBudget,
} from "../src/render/validate.js";
import { esc } from "../src/render/esc.js";
import {
  recentFixturesSkip,
  presentRecentLessonDirs,
  realFixturesSkip,
  fixturesDir,
  realEpochOf,
  REAL_STUDENT_UID,
} from "./fixtures-real.js";

const FAST = { sleep: async () => {}, backoff: [0, 0, 0] };
const NOW = Date.parse("2026-07-06T07:30:00+08:00");

// ── a mock OpenAI transport (mirrors build.test.js) ──────────────────────────
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
function emptyWire(over = {}) {
  return { classes: [], vocabulary: [], grammarGroups: [], phrasing: [], practice: [], ...over };
}

/** Run vm → gates → renderWeek while capturing every console.* call; assert none fired. */
function renderCapturingConsole(vm, ctx) {
  const seen = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const k of Object.keys(orig)) console[k] = (...a) => seen.push([k, ...a]);
  let html;
  try {
    // The three fail-closed render gates the production renderer runs before the swap.
    validateWeek(vm);
    assertSigma(vm);
    html = renderWeek(vm, ctx);
    assertBudget(html, `week ${vm.weekId}`);
  } finally {
    Object.assign(console, orig);
  }
  return { html, consoleCalls: seen };
}

// ── RECENT-shape week: the emitted page is content-rich (bugs 1·2·3·4 together) ─

test(
  "RECENT fixtures → rendered week HTML: minutes shown, non-empty practice, Focus & tutor feedback with Next-focus chip, zero console output",
  { skip: recentFixturesSkip() },
  async () => {
    const lessons = presentRecentLessonDirs()
      .map((d) => normalizeLessonDir(d, { uid: REAL_STUDENT_UID }))
      .filter((l) => l.lessonId && l.transcript.some((t) => t.speaker === "student"));
    assert.ok(lessons.length > 0, "expected recent lessons with student transcript lines");

    const win = weekWindow(Date.parse(lessons[0].startAtCST));
    const anchor = lessons[0];
    const anchorLine = anchor.transcript.find((t) => t.speaker === "student").text;
    // A short real student line (3–20 words) for the transcript-DERIVED grammar item; its
    // first letter is flipped in case so the case-insensitive guard is exercised on real data.
    const wc = (s) => s.trim().split(/\s+/).length;
    const shortLine = anchor.transcript.find((t) => t.speaker === "student" && wc(t.text) >= 3 && wc(t.text) <= 20)?.text ?? anchorLine;
    const flipCase = (s) => (s[0] === s[0].toUpperCase() ? s[0].toLowerCase() : s[0].toUpperCase()) + s.slice(1);
    const derivedSaid = flipCase(shortLine);

    // The wire the real summarizer would emit for a 0-correction week: no Cambly grammar
    // records, ONE transcript-derived grammar item; vocab quoting a real student line; a
    // moment whose highlight is a real corpus line the prose does NOT embed; practice citing
    // lessonIds (no correction ids to cite); titles for the generic "Pro Lesson" topics; and
    // the three v2 blocks (review · level · plan).
    const wire = emptyWire({
      classes: lessons.map((l, i) => {
        const s = l.transcript.find((t) => t.speaker === "student");
        return { lessonId: l.lessonId, title: `Real class ${i + 1} about work`, moment: { text: "A memorable stretch of the conversation.", quotes: s ? [s.text] : [] }, tutorNote: null };
      }),
      vocabulary: [{ term: "a real phrase", meaning: "something said in class", quote: anchorLine, quoteBy: "student", lessonId: anchor.lessonId, fromCorrectionId: null, example: null }],
      grammarGroups: [
        { pattern: "Spotted in the transcript", rule: "A synthetic rule for the test.", items: [{ correctionId: null, said: derivedSaid, fix: `${shortLine} (fixed)`, why: "synthetic why", lessonId: anchor.lessonId }] },
      ],
      practice: lessons.map((l, i) => ({
        format: i === 0 ? "FILL_THE_GAP" : "SAY_IT_BETTER",
        prompt: "____ from this week",
        cue: null,
        answer: "**answer**",
        why: "drawn from this week's real material",
        sourceIds: [l.lessonId],
      })),
      review: {
        summary: "A synthetic three-sentence review. It names what improved. It names the biggest issue.",
        wentWell: [{ point: "Kept talking in long turns", quote: anchorLine, lessonId: anchor.lessonId }],
        needsWork: [{ issue: "Synthetic issue", fix: "Synthetic fix", quote: derivedSaid, lessonId: anchor.lessonId }],
      },
      level: {
        overall: "B1+",
        confidence: lessons.length < 3 ? "low" : "medium",
        dimensions: ["range", "accuracy", "fluency", "interaction", "coherence"].map((name) => ({ name, band: "B1+", evidence: `synthetic ${name} evidence` })),
        summary: "Synthetic level summary. Synthetic next-band gap.",
        advice: [{ title: "Synthetic advice", detail: "Do the synthetic thing daily." }],
      },
      plan: {
        focus: "Synthetic focus for next week.",
        items: [{ day: "Mon", task: "Synthetic task.", why: "synthetic why" }, { day: "Daily", task: "Synthetic daily task.", why: "" }],
        askTutor: ["Ask the tutor a synthetic question."],
      },
    });

    const mock = await startMock(() => ({ status: 200, body: envelope(wire) }));
    let html, consoleCalls, vm;
    try {
      const out = await generateWeekVM({ window: win, lessons, now: NOW, base: mock.base, ...FAST });
      vm = out.weekVM;
      assert.equal(out.llmCalls, 1);
      assert.equal(out.reprompted, false);
      ({ html, consoleCalls } = renderCapturingConsole(vm));
    } finally {
      await mock.close();
    }

    // ── no console noise anywhere on the render path (exceptions already fail the test).
    assert.deepEqual(consoleCalls, [], `render path emitted console output: ${JSON.stringify(consoleCalls)}`);

    // ── Bug 1: minutes SHOWN (not 0) in the header stat band + on each class card.
    const summed = vm.classes.reduce((n, c) => n + c.minutes, 0);
    assert.ok(summed > 0, `summed class minutes > 0 (got ${summed})`);
    assert.ok(html.includes(`<div class="n">${summed}</div><div class="l">minutes</div>`), "stat band shows summed minutes");
    assert.ok(!html.includes(`<div class="n">0</div><div class="l">minutes</div>`), "NOT the minutes=0 regression");
    for (const c of vm.classes) {
      assert.ok(c.minutes > 0, `class ${c.lessonId} minutes > 0`);
      assert.match(html, new RegExp(`<span>${c.minutes} min( · with |</span>)`), `class card eyebrow shows ${c.minutes} min`);
    }

    // ── Bug 2: a non-empty practice section with ≥1 tap-to-reveal card + reveal script,
    // built with ZERO Cambly grammar records this week (the one grammar row is derived).
    assert.equal(vm.integrity.reportedCorrections, 0, "recent week has no Cambly correction records");
    assert.ok(vm.practice.length > 0, "practice VM non-empty");

    // ── v2: the transcript-derived grammar row survived the case-insensitive real-corpus
    // guard, sits OUTSIDE Σ, and renders with its source tag; header stat == section total.
    assert.equal(vm.grammarGroups.length, 1);
    const derived = vm.grammarGroups[0].items[0];
    assert.equal(derived.id, "g-d1");
    assert.equal(derived.derived, true);
    assert.equal(derived.correctionId, null);
    assert.equal(derived.said, derivedSaid, "the LLM's case-flipped span is kept verbatim");
    assert.equal(vm.integrity.derivedGrammar, 1);
    assert.equal(vm.stats.corrections, 1);
    assert.ok(html.includes('<i class="src">transcript</i>'), "derived row tagged on the page");
    assert.ok(html.includes(esc(derivedSaid)), "the derived said reached the page");
    assert.ok(html.includes(`<div class="n">1</div><div class="l">corrections</div>`), "header stat counts the derived row");
    assert.match(html, /1 grammar fix — 1 spotted in your transcript, grouped into 1 habit/);

    // ── v2: titles stand in for the generic "Pro Lesson" topics; tutors (when known) on cards.
    for (const c of vm.classes) {
      if (["", "pro lesson", "kickoff conversation", "conversation"].includes(c.topic.trim().toLowerCase())) {
        assert.match(c.title, /^Real class \d about work$/);
        assert.ok(html.includes(esc(c.title)), "the title is on the card");
      } else {
        assert.equal(c.title, null);
      }
      if (c.tutor) assert.ok(html.includes(`· with ${esc(c.tutor)}</span>`));
    }

    // ── v2: review · level · plan composed, guarded and rendered — eight sections in order.
    assert.equal(vm.review.wentWell[0].quote, anchorLine, "a real any-side quote survives");
    assert.equal(vm.review.needsWork[0].quote, derivedSaid, "a real student-side quote survives (case-insensitive)");
    assert.equal(vm.level.overall, "B1+");
    assert.equal(vm.level.bandIndex, 3);
    assert.equal(vm.level.dimensions.length, 5);
    assert.equal(vm.plan.items.length, 2);
    assert.ok(/^[A-Z][a-z]{2} \d/.test(vm.plan.weekLabel), `plan.weekLabel looks like a week label: ${vm.plan.weekLabel}`);
    const ids = [...html.matchAll(/<section id="(m-[a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, ["m-review", "m-level", "m-classes", "m-vocab", "m-grammar", "m-phrasing", "m-practice", "m-plan"]);
    assert.deepEqual([...html.matchAll(/<span class="num">(\d\d)<\/span>/g)].map((m) => m[1]), ["01", "02", "03", "04", "05", "06", "07", "08"]);
    assert.match(html, /<span class="lvbig">B1\+<\/span>/);
    assert.ok(html.includes(`Plan for the week of ${esc(vm.plan.weekLabel)}</h2>`));
    const pqCards = (html.match(/<button class="pq" aria-expanded="false" aria-controls="pa\d+">/g) || []).length;
    assert.ok(pqCards >= 1, `≥1 tap-to-reveal card in HTML (got ${pqCards})`);
    assert.ok(html.includes("querySelectorAll('.pq')"), "reveal script shipped (practice present)");
    assert.ok(!html.includes("No practice drills this week."), "practice section is NOT the empty note");

    // ── Bug 4: a "Focus & tutor feedback" block with the Next-focus chip, from the
    // ai_tutor coaching block (verbatim, not quote-guarded).
    assert.ok(html.includes('<div class="focus">'), "focus block rendered");
    assert.ok(html.includes("<div class=\"fhead\">Focus &amp; tutor feedback</div>"), "focus block heading");
    assert.ok(html.includes('<p class="fnext"><b>Next focus</b><span>'), "Next-focus chip rendered");
    const nextFocus = vm.classes.map((c) => c.tutorFocus).find((f) => f && f.nextFocus)?.nextFocus;
    assert.ok(nextFocus, "at least one class carries a nextFocus");
    assert.ok(html.includes(`<span>${esc(nextFocus)}</span>`), `the real nextFocus string is rendered: ${JSON.stringify(nextFocus)}`);

    // ── Bug 3: moment highlights are real corpus lines — no reject spam, the highlight
    // renders (its verbatim student line survives the corpus guard).
    assert.equal(vm.build.rejects.filter((r) => r.section === "moment" && r.dropped).length, 0, "zero moment rejects");
    assert.ok(html.includes('<p class="moment">'), "a class moment rendered");

    // ── The page is self-contained and within the charter byte budget (assertBudget
    // already ran inside renderCapturingConsole; re-assert the landmarks explicitly).
    assert.equal((html.match(/<h1>/g) || []).length, 1, "exactly one h1");
    assert.match(html, /^<!doctype html>/);
    // No missing field leaked as the literal string "undefined" into rendered CONTENT.
    // (The inlined reveal script legitimately uses the JS keyword `undefined`, so strip
    // <script> blocks before the check — only markup/content is a real leak surface.)
    const contentOnly = html.replace(/<script>[\s\S]*?<\/script>/g, "");
    assert.ok(!contentOnly.includes("undefined"), "no literal 'undefined' leaked into rendered content");
  },
);

// ── OLDER-shape week (real corrective corrections): structured grammar still renders ─

test(
  "OLDER fixtures → rendered week HTML: structured grammar (grouped correction rows) still emits",
  { skip: realFixturesSkip() },
  async () => {
    const DIR = "2026-05-07_69f30a9d"; // an archived lesson carrying 7 real corrections
    const base = path.join(fixturesDir(), DIR);
    const epoch = realEpochOf(DIR);
    if (typeof epoch !== "number") return; // this snapshot lacks the dir — nothing to assert
    const lesson = normalizeLessonDir(base, {
      uid: REAL_STUDENT_UID,
      lesson: { id: DIR, scheduledStartAt: { $date: epoch }, scheduledMinutes: 60, topic: "Getting to know you", tutorId: "t1" },
      tutors: { result: [{ id: "t1", displayName: "Archive Tutor" }] },
    });
    assert.ok(lesson.corrections.length > 0, `older lesson has real corrections (got ${lesson.corrections.length})`);

    const win = weekWindow(Date.parse(lesson.startAtCST));
    // The summarizer groups every real correction id into one grammar habit; said/fix are
    // builder-filled from the raw record (the LLM only supplies correctionId + why).
    const wire = emptyWire({
      grammarGroups: [
        {
          pattern: "Word choice & tense",
          rule: "match the verb/word to the real situation",
          items: lesson.corrections.map((c) => ({ correctionId: c.id, why: "from this week" })),
        },
      ],
    });

    const mock = await startMock(() => ({ status: 200, body: envelope(wire) }));
    let html, consoleCalls, vm;
    try {
      const out = await generateWeekVM({ window: win, lessons: [lesson], now: NOW, base: mock.base, ...FAST });
      vm = out.weekVM;
      ({ html, consoleCalls } = renderCapturingConsole(vm));
    } finally {
      await mock.close();
    }

    assert.deepEqual(consoleCalls, [], "no console output on the older-week render path");

    const n = lesson.corrections.length;
    // Σ closes on grammar alone: reported === renderedGrammar === n.
    assert.equal(vm.stats.corrections, n, "stats.corrections equals the raw correction count");
    assert.equal(vm.integrity.renderedGrammar, n, "every correction rendered as structured grammar");
    assert.equal(vm.integrity.renderedVocab + vm.integrity.renderedPhrasing, 0);

    // Structured grammar in the HTML: the group container, a count badge, and correction
    // rows carrying the builder-filled said → fix (never the LLM's words).
    assert.ok(html.includes('<div class="grp">'), "grammar group container rendered");
    assert.ok(html.includes(`<span class="cnt">${n}</span>`), "group count badge shows the real count");
    assert.ok(html.includes('<span class="said">'), "a struck 'said' row rendered");
    assert.ok(html.includes('<span class="fix">'), "a bold 'fix' row rendered");
    assert.ok(html.includes(`<div class="n">${n}</div><div class="l">corrections</div>`), "stat band shows the corrections count");
    assert.ok(!html.includes("No grammar corrections this week."), "grammar section is NOT the empty note");

    // A real correction's verbatim said + fix survive to the page (spot-check the first).
    const first = lesson.corrections[0];
    assert.ok(html.includes(esc(first.said)), "the raw correction 'said' text reached the page");
    assert.ok(html.includes(esc(first.fix)), "the raw correction 'fix' text reached the page");
  },
);
