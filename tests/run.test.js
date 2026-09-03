// tests/run.test.js — I-GR / I-HZ + all four outcome paths (TECH §3 run wrapper,
// §4 sequences, §5 outcomes, §7 failure matrix).
//
// A full generate run against three node:http mocks on 127.0.0.1 (Cambly, OpenAI,
// Resend) wired through the CAMBLY_BASE_URL / OPENAI_BASE_URL / RESEND_BASE_URL env
// seams, with the clock injected (nowMs) — no real network, no real clock, no
// sleeps. The mock OpenAI derives a schema-valid wire object from the request
// bundle so every week composes and passes the builder gates. Only SYNTHETIC
// fixtures are read (PRD S6).

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import { weekWindow, MS_DAY } from "../src/week.js";
import { runGenerate } from "../src/run.js";
import { RECOVERY_COMMANDS } from "../src/mail.js";

const FIXDIR = path.join(import.meta.dirname, "fixtures", "synthetic", "lesson-basic");
const readFix = (f) => JSON.parse(fs.readFileSync(path.join(FIXDIR, f), "utf8"));
const LESSON = readFix("_lesson.json");
const FIX_EPOCH = LESSON.scheduledStartAt.$date;
const FIX_WIN = weekWindow(FIX_EPOCH); // the fixture lesson's week (target on a run one week later)
// A Monday-run clock one week after the fixture week → target = the fixture week.
const RUN_NOW = FIX_WIN.startMs + 7 * MS_DAY + 12 * 3600 * 1000;

const FAST = { sleep: async () => {}, backoff: [0, 0, 0], retries: 3 };

// ── Mocks ─────────────────────────────────────────────────────────────────────────

/** Derive a schema-valid, gate-passing wire object from the summarizer's bundle. */
function wireFromBundle(bundle) {
  const lid = (bundle.match(/lessonId: (\S+)/) || [])[1] || "unknown";
  const cids = [...bundle.matchAll(/^ {2}(\S+) · "/gm)].map((m) => m[1]);
  return {
    classes: [
      {
        lessonId: lid,
        moment: {
          text: "A strong moment: Okay, we hiked for three hours.",
          quotes: ["Okay, we hiked for three hours."], // a verbatim student transcript line
        },
        tutorNote: null,
      },
    ],
    vocabulary: cids[1]
      ? [
          {
            term: "picnic",
            meaning: "an outdoor meal",
            quote: "We hiking for three hours and eat a picnic.", // verbatim student line
            quoteBy: "student",
            lessonId: lid,
            fromCorrectionId: cids[1],
          },
        ]
      : [],
    grammarGroups: cids[0]
      ? [{ pattern: "Past tense", rule: "Use past tense for finished actions.", items: [{ correctionId: cids[0], why: "the weekend is over" }] }]
      : [],
    phrasing: [],
    practice: cids[0]
      ? [{ format: "CORRECT_IT", prompt: "I ____ to the mountain.", cue: "go", answer: "I **went** to the mountain.", why: "past tense", sourceIds: [cids[0]] }]
      : [],
  };
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/**
 * Spin up all three mocks. `cfg`:
 *   listing            — array of lessons_v2 records the listing returns (default: fixture lesson)
 *   camblyAuthFail     — true → listing answers 401 + login HTML (auth-expired probe)
 *   openaiStatus       — non-200 to force a summarize failure (default 200)
 *   resendStatus       — non-2xx to force an email failure (default 200)
 *   tutorsShape        — "array" (fixture, default) | "map" (the live object-map shape) | "empty"
 */
async function makeMocks(cfg = {}) {
  const listing = cfg.listing ?? [LESSON];
  const openaiReqs = [];
  const resendReqs = [];

  const cambly = await listen((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/api/lessons_v2" && cfg.camblyAuthFail) {
      res.writeHead(401, { "Content-Type": "text/html" });
      res.end("<html><body>login</body></html>");
      return;
    }
    const send = (o) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (p === "/api/lessons_v2") return send({ result: listing });
    if (p === "/api/tutors") {
      if (cfg.tutorsShape === "map") {
        return send({ result: { tutor999: { id: "tutor999", displayName: "Sam Rivers", firstName: "Sam", lastName: "Rivers" } } });
      }
      if (cfg.tutorsShape === "empty") return send({ result: {} });
      return send(readFix("tutors.json"));
    }
    if (p.startsWith("/model/lesson_transcript/")) return send(readFix("lesson_transcript.json"));
    if (p.startsWith("/model/talon_chats/")) return send(readFix("talon_chats.json"));
    if (p === "/api/corrective_feedback_corrections") {
      if (cfg.corrFail) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      return send(readFix("corrective_feedback_corrections.json"));
    }
    if (p === "/api/positive_feedbacks") return send(readFix("positive_feedbacks.json"));
    if (p === "/api/ai_tutor_student_feedbacks") return send(readFix("ai_tutor_student_feedbacks.json"));
    if (p === "/api/tutor_student_feedbacks") return send(readFix("tutor_student_feedbacks.json"));
    if (p === "/api/user_lesson_stats") return send(readFix("user_lesson_stats.json"));
    if (p === "/api/lesson_parts") return send({ result: [] });
    if (p.startsWith("/api/lesson_plans/")) return send(readFix("lesson_plan.json"));
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: null }));
  });

  const openai = await listen((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      openaiReqs.push(raw);
      if (cfg.openaiStatus && cfg.openaiStatus !== 200) {
        res.writeHead(cfg.openaiStatus);
        res.end("{}");
        return;
      }
      const bundle = JSON.parse(raw).messages.find((m) => m.role === "user").content;
      const wire = wireFromBundle(bundle);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "cmpl", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(wire) } }], usage: { prompt_tokens: 100 } }));
    });
  });

  const resend = await listen((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      resendReqs.push(raw);
      const status = cfg.resendStatus ?? 200;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "email-1" }));
    });
  });

  process.env.CAMBLY_BASE_URL = cambly.url;
  process.env.OPENAI_BASE_URL = openai.url;
  process.env.RESEND_BASE_URL = resend.url;
  process.env.CAMBLY_UID = "student001";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.RESEND_API_KEY = "re-test";
  process.env.OPENAI_MODEL = "gpt-test";
  process.env.MAIL_FROM = "recap@example.com";
  process.env.MAIL_TO = "you@example.com";
  process.env.SITE_URL = "https://example.com";
  process.env.FIRST_WEEK = FIX_WIN.weekId;

  return {
    openaiReqs,
    resendReqs,
    close: async () => {
      await cambly.close();
      await openai.close();
      await resend.close();
    },
  };
}

function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cambly-run-"));
  return { dataDir: path.join(root, "data"), siteDir: path.join(root, "site") };
}

/** Deterministic content hash of the served site tree (index + weeks/* + healthz). */
function hashSite(siteDir) {
  const parts = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const fp = path.join(dir, e.name);
      const rp = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(fp, rp);
      else parts.push(`${rp}\u0000${fs.readFileSync(fp, "utf8")}`);
    }
  };
  walk(siteDir, "");
  return crypto.createHash("sha256").update(parts.join("\u0001")).digest("hex");
}

const run = (dataDir, siteDir, opts = {}) =>
  runGenerate({ dataDir, siteDir, nowMs: RUN_NOW, fast: FAST, monotonic: () => 0, ...opts });
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

// ── I-GR-① byte-stable + idempotent re-run ────────────────────────────────────────
test("I-GR① published run is byte-stable; the second run makes zero LLM calls and sends zero emails", async () => {
  const mocks = await makeMocks();
  const { dataDir, siteDir } = tmpDirs();
  try {
    const r1 = await run(dataDir, siteDir);
    assert.equal(r1.outcome, "published");
    assert.equal(r1.exitCode, 0);
    assert.deepEqual(r1.weeksBuilt, [FIX_WIN.weekId]);
    assert.equal(r1.emailOk, true);
    const hash1 = hashSite(siteDir);
    const openaiAfter1 = mocks.openaiReqs.length;
    const resendAfter1 = mocks.resendReqs.length;
    assert.equal(openaiAfter1, 1, "first run: exactly one LLM call");
    assert.equal(resendAfter1, 1, "first run: exactly one email");

    const r2 = await run(dataDir, siteDir);
    assert.equal(r2.outcome, "published");
    assert.deepEqual(r2.weeksBuilt, [], "second run: nothing rebuilt (already-built short-circuit)");
    const hash2 = hashSite(siteDir);
    assert.equal(hash2, hash1, "dist tree is byte-identical across runs");
    assert.equal(mocks.openaiReqs.length - openaiAfter1, 0, "second run: zero LLM calls");
    assert.equal(mocks.resendReqs.length - resendAfter1, 0, "second run: zero emails");
  } finally {
    await mocks.close();
  }
});

// ── I-GR-② the published week page carries composed, real content ────────────────
test("I-GR② the published week page renders composed content (moment quote, correction fix, practice answer)", async () => {
  const mocks = await makeMocks();
  const { dataDir, siteDir } = tmpDirs();
  try {
    await run(dataDir, siteDir);
    const page = fs.readFileSync(path.join(siteDir, "weeks", `${FIX_WIN.weekId}.html`), "utf8");
    assert.match(page, /Okay, we hiked for three hours\./); // moment quote, guard-verified
    assert.match(page, /I went to the mountain with my family\./); // grammar fix, builder-copied from raw
    assert.match(page, /went to the mountain/); // practice answer highlight
    // The Σ arithmetic re-asserts in the renderer, so a rendered page proves it held.
    const vm = readJson(path.join(dataDir, "weeks", `${FIX_WIN.weekId}.json`));
    // stats.corrections is the Grammar-section total (finding 4); the raw Σ anchor kept in
    // integrity accounts for every correction (grammar + vocab + phrasing).
    assert.equal(vm.stats.corrections, vm.integrity.renderedGrammar);
    assert.equal(
      vm.integrity.reportedCorrections,
      vm.integrity.renderedGrammar + vm.integrity.renderedVocab + vm.integrity.renderedPhrasing,
    );
  } finally {
    await mocks.close();
  }
});

// ── published email body content ─────────────────────────────────────────────────
test("published run sends the 📗 email with the stat line and the deep link to the week page", async () => {
  const mocks = await makeMocks();
  const { dataDir, siteDir } = tmpDirs();
  try {
    await run(dataDir, siteDir);
    assert.equal(mocks.resendReqs.length, 1);
    const sent = JSON.parse(mocks.resendReqs[0]);
    // corrections = the Grammar-section total (finding 4): the fixture's 2 raw corrections
    // render as 1 grammar item + 1 vocab expression, so the user-facing count is 1.
    assert.match(sent.subject, /^📗 Cambly recap: Week of .+ — 1 class, 1 correction$/);
    assert.equal(sent.from, "recap@example.com");
    assert.equal(sent.to, "you@example.com");
    assert.match(sent.text, new RegExp(`https://example\\.com/weeks/${FIX_WIN.weekId}\\.html`));
    assert.match(sent.text, /1 classes · \d+ minutes · 1 corrections · 1 expressions/);
  } finally {
    await mocks.close();
  }
});

// ── no-classes outcome ────────────────────────────────────────────────────────────
test("no-classes: empty target week → 📭 email, isEmpty stub, no page, muted index row, exit 0", async () => {
  const mocks = await makeMocks({ listing: [] });
  const { dataDir, siteDir } = tmpDirs();
  try {
    const r = await run(dataDir, siteDir);
    assert.equal(r.outcome, "no-classes");
    assert.equal(r.exitCode, 0);
    assert.equal(mocks.openaiReqs.length, 0, "an empty week makes zero LLM calls");
    // isEmpty stub written, but no page emitted.
    const vm = readJson(path.join(dataDir, "weeks", `${FIX_WIN.weekId}.json`));
    assert.equal(vm.isEmpty, true);
    assert.equal(fs.existsSync(path.join(siteDir, "weeks", `${FIX_WIN.weekId}.html`)), false);
    assert.equal(fs.existsSync(path.join(siteDir, "index.html")), true);
    // 📭 email, healthz still ok (no-classes is a healthy outcome).
    assert.equal(mocks.resendReqs.length, 1);
    assert.equal(JSON.parse(mocks.resendReqs[0]).subject, "📭 No Cambly classes last week");
    assert.equal(readJson(path.join(siteDir, "healthz.json")).ok, true);
  } finally {
    await mocks.close();
  }
});

// ── auth-expired outcome + banner injection + recovery-command email ─────────────
test("auth-expired: 🔑 email with the exact recovery commands, amber banner re-render, healthz ok:false, exit 3", async () => {
  // First publish a healthy week so there is an existing page to re-render with the banner.
  const good = await makeMocks();
  const { dataDir, siteDir } = tmpDirs();
  await run(dataDir, siteDir);
  await good.close();

  const mocks = await makeMocks({ camblyAuthFail: true });
  try {
    const r = await run(dataDir, siteDir);
    assert.equal(r.outcome, "auth-expired");
    assert.equal(r.exitCode, 3);
    // The alert email carries BOTH recovery commands byte-equal to the banner constant.
    const sent = JSON.parse(mocks.resendReqs[0]);
    assert.equal(sent.subject, "🔑 Cambly session expired — recap paused");
    assert.ok(sent.text.includes(RECOVERY_COMMANDS[0]));
    assert.ok(sent.text.includes(RECOVERY_COMMANDS[1]));
    // site-state flips authStale, healthz goes red, and the banner is re-rendered on the page.
    assert.equal(readJson(path.join(dataDir, "site-state.json")).authStale, true);
    const healthz = readJson(path.join(siteDir, "healthz.json"));
    assert.equal(healthz.ok, false);
    assert.equal(healthz.lastOutcome, "auth-expired");
    const page = fs.readFileSync(path.join(siteDir, "weeks", `${FIX_WIN.weekId}.html`), "utf8");
    assert.match(page, /role="alert"/); // amber banner injected
    assert.ok(page.includes("cambly-state.json")); // banner shows the recovery steps
  } finally {
    await mocks.close();
  }
});

// ── fetch-failed outcome (summarize stage) — site unchanged ──────────────────────
test("fetch-failed: OpenAI 5xx ×3 → ⚠️ email (stage summarize), site unchanged, healthz ok:false, exit 2", async () => {
  const mocks = await makeMocks({ openaiStatus: 500 });
  const { dataDir, siteDir } = tmpDirs();
  try {
    const r = await run(dataDir, siteDir);
    assert.equal(r.outcome, "fetch-failed");
    assert.equal(r.exitCode, 2);
    assert.equal(mocks.openaiReqs.length, 3, "summarize retried three times");
    // Site unchanged: no index/page published on this first-ever failed run.
    assert.equal(fs.existsSync(path.join(siteDir, "index.html")), false);
    // ⚠️ alert with the stage, healthz red.
    const sent = JSON.parse(mocks.resendReqs[0]);
    assert.equal(sent.subject, "⚠️ Cambly recap failed (stage: summarize)");
    assert.match(sent.text, /summarize stage/);
    const healthz = readJson(path.join(siteDir, "healthz.json"));
    assert.equal(healthz.ok, false);
    assert.equal(healthz.lastOutcome, "fetch-failed");
  } finally {
    await mocks.close();
  }
});

test("fetch-failed after a prior publish leaves the served site untouched (fail-closed)", async () => {
  const good = await makeMocks();
  const { dataDir, siteDir } = tmpDirs();
  await run(dataDir, siteDir);
  await good.close();
  const beforeHash = hashSite(siteDir);
  const pageBefore = fs.readFileSync(path.join(siteDir, "weeks", `${FIX_WIN.weekId}.html`), "utf8");

  // A later run whose target is already built AND OpenAI is down: nothing to rebuild,
  // so the run is a healthy no-op re-render (not a failure) — the served site is byte-identical.
  const mocks = await makeMocks({ openaiStatus: 500 });
  try {
    const r = await run(dataDir, siteDir);
    assert.equal(r.outcome, "published"); // target already built → no LLM call needed
    assert.equal(mocks.openaiReqs.length, 0);
    assert.equal(hashSite(siteDir), beforeHash, "served site is byte-identical");
    assert.equal(fs.readFileSync(path.join(siteDir, "weeks", `${FIX_WIN.weekId}.html`), "utf8"), pageBefore);
  } finally {
    await mocks.close();
  }
});

// ── I-HZ-② healthz written LAST — emailOk reflects a mail failure, publish stands ─
test("I-HZ② Resend 5xx ×3 → outcome stands (published, exit 0), healthz.emailOk:false written LAST", async () => {
  const mocks = await makeMocks({ resendStatus: 500 });
  const { dataDir, siteDir } = tmpDirs();
  try {
    const r = await run(dataDir, siteDir);
    assert.equal(r.outcome, "published");
    assert.equal(r.exitCode, 0, "the email failing never rolls back the publish");
    assert.equal(r.emailOk, false);
    assert.equal(mocks.resendReqs.length, 3, "email retried three times");
    // The week page was still published…
    assert.equal(fs.existsSync(path.join(siteDir, "weeks", `${FIX_WIN.weekId}.html`)), true);
    // …and healthz — written after the mail attempt — carries the final emailOk:false ⇒ ok:false.
    const healthz = readJson(path.join(siteDir, "healthz.json"));
    assert.equal(healthz.emailOk, false);
    assert.equal(healthz.ok, false);
    assert.equal(healthz.lastOutcome, "published");
  } finally {
    await mocks.close();
  }
});

// ── fetch-failed outcome (dead corrections endpoint) — §7 Σ-trust ────────────────
test("fetch-failed: a dead corrections endpoint (500 ×3) refuses to publish a silently-zeroed Σ set (§7)", async () => {
  const mocks = await makeMocks({ corrFail: true });
  const { dataDir, siteDir } = tmpDirs();
  try {
    const r = await run(dataDir, siteDir);
    assert.equal(r.outcome, "fetch-failed");
    assert.equal(r.exitCode, 2);
    // No week was published from a zeroed correction set (first-ever run → no site).
    assert.equal(fs.existsSync(path.join(siteDir, "index.html")), false);
    assert.equal(fs.existsSync(path.join(dataDir, "weeks", `${FIX_WIN.weekId}.json`)), false);
    // ⚠️ alert names the fetch stage; healthz goes red.
    const sent = JSON.parse(mocks.resendReqs[0]);
    assert.match(sent.subject, /stage: fetch/);
    const healthz = readJson(path.join(siteDir, "healthz.json"));
    assert.equal(healthz.ok, false);
    assert.equal(healthz.lastOutcome, "fetch-failed");
    // The raw stub is on disk so the next run re-fetches (self-heal), not a permanent brick.
    const corr = readJson(path.join(dataDir, "raw", LESSON.id, "corrective_feedback_corrections.json"));
    assert.deepEqual(corr, { __status: 500 });
  } finally {
    await mocks.close();
  }
});

// ── missed-week backfill within a normal run ─────────────────────────────────────
test("missed-week self-heal: a normal run also builds a complete earlier week that lacks a VM file", async () => {
  const early = { ...LESSON, id: "L-early", scheduledStartAt: { $date: FIX_EPOCH - 7 * MS_DAY } };
  const mocks = await makeMocks({ listing: [LESSON, early] });
  const { dataDir, siteDir } = tmpDirs();
  try {
    process.env.FIRST_WEEK = weekWindow(FIX_EPOCH - 7 * MS_DAY).weekId; // include the earlier week
    const r = await run(dataDir, siteDir);
    assert.equal(r.outcome, "published");
    const earlierWeekId = weekWindow(FIX_EPOCH - 7 * MS_DAY).weekId;
    assert.ok(r.weeksBuilt.includes(earlierWeekId), "the earlier missed week was backfilled");
    assert.ok(r.weeksBuilt.includes(FIX_WIN.weekId), "the target week was built");
    assert.equal(r.backfilledCount, 1, "one non-empty backfilled week");
    // Both pages exist; the 📗 email notes the backfill.
    assert.equal(fs.existsSync(path.join(siteDir, "weeks", `${earlierWeekId}.html`)), true);
    assert.equal(fs.existsSync(path.join(siteDir, "weeks", `${FIX_WIN.weekId}.html`)), true);
    assert.match(JSON.parse(mocks.resendReqs[0]).text, /Also backfilled: 1 missed week\./);
    assert.equal(mocks.openaiReqs.length, 2, "one LLM call per non-empty week");
  } finally {
    await mocks.close();
  }
});

// ── --backfill mode ──────────────────────────────────────────────────────────────
test("--backfill paginates history and summarizes every non-empty week down to FIRST_WEEK", async () => {
  const early = { ...LESSON, id: "L-early", scheduledStartAt: { $date: FIX_EPOCH - 7 * MS_DAY } };
  const mocks = await makeMocks({ listing: [LESSON, early] });
  const { dataDir, siteDir } = tmpDirs();
  try {
    process.env.FIRST_WEEK = weekWindow(FIX_EPOCH - 7 * MS_DAY).weekId;
    const r = await run(dataDir, siteDir, { backfill: true });
    assert.equal(r.outcome, "published");
    const earlierWeekId = weekWindow(FIX_EPOCH - 7 * MS_DAY).weekId;
    assert.ok(r.weeksBuilt.includes(earlierWeekId));
    assert.ok(r.weeksBuilt.includes(FIX_WIN.weekId));
    const runsLog = fs.readFileSync(path.join(dataDir, "runs.ndjson"), "utf8").trim().split("\n");
    assert.equal(JSON.parse(runsLog.at(-1)).trigger, "backfill");
  } finally {
    await mocks.close();
  }
});

// ── tutors map (spec A1): persisted flat map, raw tutors.json shape, never shrinks ─

const SAM = { tutor999: { id: "tutor999", displayName: "Sam Rivers" } };

test("published run persists the fetched tutors as the flat map in data/tutors.json (array-shaped endpoint)", async () => {
  const mocks = await makeMocks();
  const { dataDir, siteDir } = tmpDirs();
  try {
    await run(dataDir, siteDir);
    assert.deepEqual(readJson(path.join(dataDir, "tutors.json")), SAM);
    // The per-lesson raw tutors.json carries {result: <the lesson's slice of the map>}.
    assert.deepEqual(readJson(path.join(dataDir, "raw", LESSON.id, "tutors.json")), { result: SAM });
    // …and the tutor reaches the class card and the page header.
    const vm = readJson(path.join(dataDir, "weeks", `${FIX_WIN.weekId}.json`));
    assert.equal(vm.classes[0].tutor, "Sam Rivers");
    const page = fs.readFileSync(path.join(siteDir, "weeks", `${FIX_WIN.weekId}.html`), "utf8");
    assert.match(page, /with Sam Rivers/);
  } finally {
    await mocks.close();
  }
});

test("the live object-map /api/tutors shape is accepted — the tutor is named, not lost (data finding 1)", async () => {
  const mocks = await makeMocks({ tutorsShape: "map" });
  const { dataDir, siteDir } = tmpDirs();
  try {
    await run(dataDir, siteDir);
    assert.deepEqual(readJson(path.join(dataDir, "tutors.json")), SAM);
    const vm = readJson(path.join(dataDir, "weeks", `${FIX_WIN.weekId}.json`));
    assert.equal(vm.classes[0].tutor, "Sam Rivers");
    assert.match(fs.readFileSync(path.join(siteDir, "weeks", `${FIX_WIN.weekId}.html`), "utf8"), /with Sam Rivers/);
  } finally {
    await mocks.close();
  }
});

test("data/tutors.json never shrinks: a pre-seeded tutor survives a run that fetches a different one", async () => {
  const mocks = await makeMocks();
  const { dataDir, siteDir } = tmpDirs();
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "tutors.json"), JSON.stringify({ other: { id: "other", displayName: "Old Tutor" } }));
    await run(dataDir, siteDir);
    assert.deepEqual(readJson(path.join(dataDir, "tutors.json")), {
      other: { id: "other", displayName: "Old Tutor" },
      ...SAM,
    });
  } finally {
    await mocks.close();
  }
});

test("an empty tutors answer leaves data/tutors.json untouched and the persisted name still resolves", async () => {
  const mocks = await makeMocks({ tutorsShape: "empty" });
  const { dataDir, siteDir } = tmpDirs();
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const seeded = JSON.stringify({ tutor999: { id: "tutor999", displayName: "Seeded Sam" } });
    fs.writeFileSync(path.join(dataDir, "tutors.json"), seeded);
    await run(dataDir, siteDir);
    assert.equal(fs.readFileSync(path.join(dataDir, "tutors.json"), "utf8"), seeded, "no rewrite on an empty fetch");
    const vm = readJson(path.join(dataDir, "weeks", `${FIX_WIN.weekId}.json`));
    assert.equal(vm.classes[0].tutor, "Seeded Sam");
  } finally {
    await mocks.close();
  }
});

// ── tutor self-heal in the online run (spec A2) ───────────────────────────────

test("a published VM whose class lost its tutor is self-healed on the next run, idempotently", async () => {
  const mocks = await makeMocks();
  const { dataDir, siteDir } = tmpDirs();
  try {
    await run(dataDir, siteDir);
    // Doctor the published VM the way the v1 bug left every prod week: tutor "".
    const vmPath = path.join(dataDir, "weeks", `${FIX_WIN.weekId}.json`);
    const vm = readJson(vmPath);
    fs.writeFileSync(vmPath, JSON.stringify({ ...vm, classes: vm.classes.map((c) => ({ ...c, tutor: "" })) }, null, 2) + "\n");
    const llmBefore = mocks.openaiReqs.length;

    const r2 = await run(dataDir, siteDir); // target already built → no LLM, but the heal runs
    assert.equal(r2.outcome, "published");
    assert.equal(mocks.openaiReqs.length, llmBefore, "self-heal makes zero LLM calls");
    assert.equal(readJson(vmPath).classes[0].tutor, "Sam Rivers");
    assert.match(fs.readFileSync(path.join(siteDir, "weeks", `${FIX_WIN.weekId}.html`), "utf8"), /with Sam Rivers/);
    const runsLog = fs.readFileSync(path.join(dataDir, "runs.ndjson"), "utf8").trim().split("\n");
    assert.equal(JSON.parse(runsLog.at(-1)).tutorsPatched, 1);

    const hash2 = hashSite(siteDir);
    await run(dataDir, siteDir);
    const runsLog3 = fs.readFileSync(path.join(dataDir, "runs.ndjson"), "utf8").trim().split("\n");
    assert.equal(JSON.parse(runsLog3.at(-1)).tutorsPatched, 0, "nothing left to heal");
    assert.equal(hashSite(siteDir), hash2, "site byte-identical once healed");
  } finally {
    await mocks.close();
  }
});
