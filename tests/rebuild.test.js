// tests/rebuild.test.js — the offline modes (spec A4/A5): --rebuild=<weekId>[,…] and --render,
// plus the tutor self-heal (patchTutorNames) and the CLI flag parser.
//
// Everything runs from a temp data dir seeded with the SYNTHETIC lesson fixture laid out
// the way prod leaves it: a complete raw/<lessonId>/ dir whose tutors.json is the v1
// `{result: []}` (the tutor was never captured) and a data/tutors.json seed map. The
// summarizer is injected (no OpenAI), fetch is a thrower (no network), mail is a spy.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { weekWindow, MS_DAY } from "../src/week.js";
import { runRebuild, runRender, patchTutorNames, parseArgs } from "../src/run.js";

const FIXDIR = path.join(import.meta.dirname, "fixtures", "synthetic", "lesson-basic");
const readFix = (f) => JSON.parse(fs.readFileSync(path.join(FIXDIR, f), "utf8"));
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const LESSON = readFix("_lesson.json");
const WEEK = weekWindow(LESSON.scheduledStartAt.$date);
const PREV_WEEK = weekWindow(LESSON.scheduledStartAt.$date - 7 * MS_DAY);
const CIDS = readFix("corrective_feedback_corrections.json").result.map((c) => c.id || c._id.$oid);
const SEED_TUTORS = { tutor999: { id: "tutor999", displayName: "Sam Rivers" } };
const NOW = WEEK.startMs + 14 * MS_DAY; // any later clock — offline modes never pick a target week

process.env.CAMBLY_UID = "student001";
process.env.OPENAI_API_KEY = "sk-test";
process.env.OPENAI_MODEL = "gpt-test";
process.env.MAIL_FROM = "recap@example.com";
process.env.MAIL_TO = "you@example.com";
process.env.SITE_URL = "https://example.com";

// ── fixtures & seams ──────────────────────────────────────────────────────────

/** A schema-valid, gate-passing wire for the synthetic lesson content (mirrors run.test.js's mock). */
const wireFor = (lessonId) => ({
  classes: [
    {
      lessonId,
      moment: { text: "A strong moment: Okay, we hiked for three hours.", quotes: ["Okay, we hiked for three hours."] },
      tutorNote: null,
    },
  ],
  vocabulary: [
    {
      term: "picnic",
      meaning: "an outdoor meal",
      quote: "We hiking for three hours and eat a picnic.",
      quoteBy: "student",
      lessonId,
      fromCorrectionId: CIDS[1],
    },
  ],
  grammarGroups: [
    { pattern: "Past tense", rule: "Use past tense for finished actions.", items: [{ correctionId: CIDS[0], why: "the weekend is over" }] },
  ],
  phrasing: [],
  practice: [
    { format: "CORRECT_IT", prompt: "I ____ to the mountain.", cue: "go", answer: "I **went** to the mountain.", why: "past tense", sourceIds: [CIDS[0]] },
  ],
});

/** Lay the synthetic fixture down as a complete prod-shaped raw dir for `lesson`. */
function writeRawDir(dataDir, lesson) {
  const dir = path.join(dataDir, "raw", lesson.id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(FIXDIR)) {
    if (f !== "_lesson.json" && f !== "tutors.json") fs.copyFileSync(path.join(FIXDIR, f), path.join(dir, f));
  }
  fs.writeFileSync(path.join(dir, "_lesson.json"), JSON.stringify(lesson, null, 2));
  fs.writeFileSync(path.join(dir, "tutors.json"), JSON.stringify({ result: [] })); // v1 left every lesson like this
  return dir;
}

function seed({ tutors = SEED_TUTORS, lessons = [LESSON] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cambly-rebuild-"));
  const dataDir = path.join(root, "data");
  const siteDir = path.join(root, "site");
  fs.mkdirSync(dataDir, { recursive: true });
  for (const l of lessons) writeRawDir(dataDir, l);
  if (tutors) fs.writeFileSync(path.join(dataDir, "tutors.json"), JSON.stringify(tutors));
  return { dataDir, siteDir };
}

function seams() {
  const calls = { summarize: [], net: [], mails: [] };
  return {
    calls,
    summarize: async ({ bundle, model, rejections = null }) => {
      calls.summarize.push({ bundle, model, rejections });
      const lessonId = (bundle.match(/lessonId: (\S+)/) || [])[1] || LESSON.id; // the week's first lesson
      return { wire: wireFor(lessonId), promptTokens: 42, model, raw: {} };
    },
    fetchImpl: async (url) => {
      calls.net.push(String(url));
      throw new Error(`unexpected network call: ${url}`);
    },
    mailSend: async (outcome, ctx) => {
      calls.mails.push({ outcome, ctx });
      return { ok: true };
    },
  };
}

const lastRun = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, "runs.ndjson"), "utf8").trim().split("\n").at(-1));
const rebuild = (dirs, s, extra = {}) =>
  runRebuild({ ...dirs, weekIds: [WEEK.weekId], nowMs: NOW, monotonic: () => 0, summarize: s.summarize, fetchImpl: s.fetchImpl, mailSend: s.mailSend, ...extra });

// ── --rebuild ─────────────────────────────────────────────────────────────────

test("runRebuild re-summarizes a week offline: VM written, page rendered, tutor named from data/tutors.json, no network, no mail", async () => {
  const dirs = seed();
  const s = seams();

  const r = await rebuild(dirs, s);

  assert.equal(r.outcome, "published");
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.weeksBuilt, [WEEK.weekId]);
  assert.equal(s.calls.summarize.length, 1, "exactly one LLM call (injected)");
  assert.deepEqual(s.calls.net, [], "no Cambly / network call at all");
  assert.deepEqual(s.calls.mails, [], "no email without --mail");
  // The VM was normalized through the persisted tutors map although raw tutors.json is empty.
  const vm = readJson(path.join(dirs.dataDir, "weeks", `${WEEK.weekId}.json`));
  assert.equal(vm.classes.length, 1);
  assert.equal(vm.classes[0].lessonId, LESSON.id);
  assert.equal(vm.classes[0].tutor, "Sam Rivers");
  assert.equal(vm.stats.corrections, vm.integrity.renderedGrammar, "Σ held");
  // Site rendered + healthz written; site-state.json never created by an offline mode.
  const page = fs.readFileSync(path.join(dirs.siteDir, "weeks", `${WEEK.weekId}.html`), "utf8");
  assert.match(page, /with Sam Rivers/);
  assert.match(page, /Okay, we hiked for three hours\./);
  assert.equal(fs.existsSync(path.join(dirs.siteDir, "index.html")), true);
  assert.equal(readJson(path.join(dirs.siteDir, "healthz.json")).ok, true);
  assert.equal(fs.existsSync(path.join(dirs.dataDir, "site-state.json")), false);
  // runs.ndjson records the offline trigger.
  const entry = lastRun(dirs.dataDir);
  assert.equal(entry.trigger, "rebuild");
  assert.equal(entry.outcome, "published");
  assert.deepEqual(entry.weeksBuilt, [WEEK.weekId]);
  assert.equal(entry.lessonsFetched, 0);
  assert.equal(entry.tutorsPatched, 0, "the fresh VM already carries the tutor");
  assert.equal(entry.error, null);
});

test("runRebuild --mail sends exactly one 📗 context per rebuilt week and nothing else", async () => {
  const dirs = seed();
  const s = seams();

  const r = await rebuild(dirs, s, { mail: true });

  assert.equal(r.exitCode, 0);
  assert.equal(r.emailOk, true);
  assert.equal(s.calls.mails.length, 1);
  assert.equal(s.calls.mails[0].outcome, "published");
  assert.equal(s.calls.mails[0].ctx.weekId, WEEK.weekId);
  assert.equal(s.calls.mails[0].ctx.weekUrl, `https://example.com/weeks/${WEEK.weekId}.html`);
  assert.equal(s.calls.mails[0].ctx.stats.classes, 1);
});

test("runRebuild leaves an existing site-state.json byte-identical (healthz still reflects it)", async () => {
  const dirs = seed();
  const s = seams();
  const state = JSON.stringify({ schemaVersion: 1, lastRunAt: "2026-06-01T07:30:00+08:00", lastOutcome: "published", authStale: false, authStaleSince: null, emailOk: false, recoveryCommands: [] }, null, 2) + "\n";
  fs.writeFileSync(path.join(dirs.dataDir, "site-state.json"), state);

  const r = await rebuild(dirs, s, { mail: true });

  assert.equal(r.exitCode, 0);
  assert.equal(fs.readFileSync(path.join(dirs.dataDir, "site-state.json"), "utf8"), state);
  const healthz = readJson(path.join(dirs.siteDir, "healthz.json"));
  assert.equal(healthz.emailOk, false, "emailOk stays whatever the last cron run recorded");
  assert.equal(healthz.lastRunAt, "2026-06-01T07:30:00+08:00");
});

test("runRebuild rebuilds two weeks in one run and de-duplicates / snaps non-Monday ids", async () => {
  const early = { ...LESSON, id: "L-early", scheduledStartAt: { $date: LESSON.scheduledStartAt.$date - 7 * MS_DAY } };
  const dirs = seed({ lessons: [LESSON, early] });
  const s = seams();
  const wednesday = weekWindow(LESSON.scheduledStartAt.$date).startDate.replace(/\d{2}$/, (d) => String(Number(d) + 2).padStart(2, "0"));

  const r = await rebuild(dirs, s, { weekIds: [wednesday, WEEK.weekId, PREV_WEEK.weekId] });

  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.weeksBuilt, [PREV_WEEK.weekId, WEEK.weekId].sort());
  assert.equal(s.calls.summarize.length, 2, "one LLM call per rebuilt non-empty week");
  assert.equal(fs.existsSync(path.join(dirs.siteDir, "weeks", `${PREV_WEEK.weekId}.html`)), true);
  assert.equal(fs.existsSync(path.join(dirs.siteDir, "weeks", `${WEEK.weekId}.html`)), true);
});

test("runRebuild writes an isEmpty stub for a week with no raw lessons and no prior VM (no-classes, zero LLM)", async () => {
  const dirs = seed();
  const s = seams();

  const r = await rebuild(dirs, s, { weekIds: [PREV_WEEK.weekId], mail: true });

  assert.equal(r.outcome, "no-classes");
  assert.equal(r.exitCode, 0);
  assert.equal(s.calls.summarize.length, 0);
  assert.equal(readJson(path.join(dirs.dataDir, "weeks", `${PREV_WEEK.weekId}.json`)).isEmpty, true);
  assert.equal(s.calls.mails.length, 1);
  assert.equal(s.calls.mails[0].outcome, "no-classes");
});

test("runRebuild refuses to overwrite a non-empty VM when its week has no complete raw lessons (exit 2, no mail)", async () => {
  const dirs = seed();
  const s = seams();
  const vmPath = path.join(dirs.dataDir, "weeks", `${PREV_WEEK.weekId}.json`);
  fs.mkdirSync(path.dirname(vmPath), { recursive: true });
  const doctored = JSON.stringify({ weekId: PREV_WEEK.weekId, isEmpty: false, classes: [{ lessonId: "gone" }] });
  fs.writeFileSync(vmPath, doctored);

  const r = await rebuild(dirs, s, { weekIds: [PREV_WEEK.weekId], mail: true });

  assert.equal(r.outcome, "fetch-failed");
  assert.equal(r.exitCode, 2);
  assert.equal(fs.readFileSync(vmPath, "utf8"), doctored, "the VM is untouched");
  assert.equal(s.calls.summarize.length, 0);
  assert.deepEqual(s.calls.mails, [], "a failed rebuild never mails, even with --mail");
  assert.match(lastRun(dirs.dataDir).error, /refusing to overwrite/);
  assert.equal(fs.existsSync(path.join(dirs.siteDir, "index.html")), false, "no render on failure");
});

test("runRebuild rejects an invalid or missing weekId list with exit 2", async () => {
  const dirs = seed();
  const s = seams();

  const bad = await rebuild(dirs, s, { weekIds: ["not-a-week"] });
  assert.equal(bad.exitCode, 2);
  assert.match(lastRun(dirs.dataDir).error, /invalid weekId/);

  const none = await rebuild(dirs, s, { weekIds: [] });
  assert.equal(none.exitCode, 2);
  assert.match(lastRun(dirs.dataDir).error, /at least one weekId/);
  assert.equal(s.calls.summarize.length, 0);
});

test("runRebuild: a summarizer failure → fetch-failed, exit 2, no VM, no render, no mail", async () => {
  const dirs = seed();
  const s = seams();
  const boom = async () => {
    throw Object.assign(new Error("OpenAI HTTP 500"), { name: "OpenAIError" });
  };

  const r = await rebuild(dirs, s, { summarize: boom, mail: true });

  assert.equal(r.outcome, "fetch-failed");
  assert.equal(r.exitCode, 2);
  assert.equal(fs.existsSync(path.join(dirs.dataDir, "weeks", `${WEEK.weekId}.json`)), false);
  assert.equal(fs.existsSync(path.join(dirs.siteDir, "index.html")), false);
  assert.deepEqual(s.calls.mails, []);
  const entry = lastRun(dirs.dataDir);
  assert.equal(entry.trigger, "rebuild");
  assert.equal(entry.outcome, "fetch-failed");
  assert.equal(entry.error, "OpenAIError: OpenAI HTTP 500");
});

// ── --render ──────────────────────────────────────────────────────────────────

test("runRender re-renders offline with zero LLM and zero network, healing tutors from data/tutors.json", async () => {
  const dirs = seed();
  const s = seams();
  await rebuild(dirs, s);
  // Blank the tutor the way the v1 bug left every prod week, and remove the rendered site.
  const vmPath = path.join(dirs.dataDir, "weeks", `${WEEK.weekId}.json`);
  const vm = readJson(vmPath);
  fs.writeFileSync(vmPath, JSON.stringify({ ...vm, classes: vm.classes.map((c) => ({ ...c, tutor: "" })) }, null, 2) + "\n");
  fs.rmSync(dirs.siteDir, { recursive: true, force: true });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected network call: ${url}`);
  };
  try {
    const r = await runRender({ ...dirs, nowMs: NOW, monotonic: () => 0 });

    assert.equal(r.outcome, "published");
    assert.equal(r.exitCode, 0);
    assert.equal(r.tutorsPatched, 1);
    assert.deepEqual(r.weekPages, [WEEK.weekId]);
    assert.equal(readJson(vmPath).classes[0].tutor, "Sam Rivers");
    assert.match(fs.readFileSync(path.join(dirs.siteDir, "weeks", `${WEEK.weekId}.html`), "utf8"), /with Sam Rivers/);
    assert.equal(readJson(path.join(dirs.siteDir, "healthz.json")).ok, true);
    const entry = lastRun(dirs.dataDir);
    assert.equal(entry.trigger, "render");
    assert.equal(entry.tutorsPatched, 1);
    assert.deepEqual(entry.weeksBuilt, []);
    assert.equal(s.calls.summarize.length, 1, "the render made no additional LLM call");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("runRender exits 2 when the render aborts on a bad VM and leaves the served site untouched", async () => {
  const dirs = seed();
  const s = seams();
  await rebuild(dirs, s);
  const indexBefore = fs.readFileSync(path.join(dirs.siteDir, "index.html"), "utf8");
  fs.writeFileSync(path.join(dirs.dataDir, "weeks", "2026-01-05.json"), JSON.stringify({ schemaVersion: 99, weekId: "2026-01-05" }));

  const r = await runRender({ ...dirs, nowMs: NOW, monotonic: () => 0 });

  assert.equal(r.outcome, "fetch-failed");
  assert.equal(r.exitCode, 2);
  assert.equal(fs.readFileSync(path.join(dirs.siteDir, "index.html"), "utf8"), indexBefore);
  const entry = lastRun(dirs.dataDir);
  assert.equal(entry.trigger, "render");
  assert.match(entry.error, /schemaVersion/);
});

// ── patchTutorNames (spec A2) ─────────────────────────────────────────────────

test("patchTutorNames names every empty-tutor class via raw/_lesson.json, leaves unknown tutors alone, and is idempotent", () => {
  const other = { ...LESSON, id: "L-other", tutorId: "unknown1", tutorIds: ["unknown1"] };
  const dirs = seed({ lessons: [LESSON, other] });
  const vmPath = path.join(dirs.dataDir, "weeks", `${WEEK.weekId}.json`);
  fs.mkdirSync(path.dirname(vmPath), { recursive: true });
  const vm = {
    weekId: WEEK.weekId,
    classes: [
      { lessonId: LESSON.id, tutor: "" },
      { lessonId: "L-other", tutor: "" },
      { lessonId: "L-missing-raw", tutor: "" },
      { lessonId: LESSON.id, tutor: "Already Named" },
    ],
  };
  fs.writeFileSync(vmPath, JSON.stringify(vm));
  const logs = [];

  const n1 = patchTutorNames({ dataDir: dirs.dataDir, tutorsMap: SEED_TUTORS, log: (m) => logs.push(m) });

  assert.equal(n1, 1);
  assert.deepEqual(readJson(vmPath).classes.map((c) => c.tutor), ["Sam Rivers", "", "", "Already Named"]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(WEEK.weekId));
  const bytes = fs.readFileSync(vmPath, "utf8");

  const n2 = patchTutorNames({ dataDir: dirs.dataDir, tutorsMap: SEED_TUTORS });
  assert.equal(n2, 0);
  assert.equal(fs.readFileSync(vmPath, "utf8"), bytes, "no rewrite when nothing changes");
});

test("patchTutorNames accepts any tutors payload shape and is a no-op for an empty map or a missing weeks dir", () => {
  const dirs = seed();
  const vmPath = path.join(dirs.dataDir, "weeks", `${WEEK.weekId}.json`);
  fs.mkdirSync(path.dirname(vmPath), { recursive: true });
  fs.writeFileSync(vmPath, JSON.stringify({ weekId: WEEK.weekId, classes: [{ lessonId: LESSON.id, tutor: "" }] }));

  assert.equal(patchTutorNames({ dataDir: dirs.dataDir, tutorsMap: {} }), 0);
  assert.equal(readJson(vmPath).classes[0].tutor, "");
  assert.equal(patchTutorNames({ dataDir: path.join(dirs.dataDir, "nowhere"), tutorsMap: SEED_TUTORS }), 0);
  // The array-shaped payload works too (normalizeTutors under the hood).
  assert.equal(patchTutorNames({ dataDir: dirs.dataDir, tutorsMap: { result: [{ id: "tutor999", displayName: "Sam Rivers" }] } }), 1);
  assert.equal(readJson(vmPath).classes[0].tutor, "Sam Rivers");
});

// ── parseArgs ─────────────────────────────────────────────────────────────────

test("parseArgs reads --rebuild=<ids> (comma list), --render and --mail alongside the legacy flags", () => {
  assert.deepEqual(parseArgs(["--rebuild=2026-08-24, 2026-08-17,", "--mail"]), {
    backfill: false,
    force: false,
    manual: false,
    render: false,
    mail: true,
    rebuild: ["2026-08-24", "2026-08-17"],
  });
  assert.deepEqual(parseArgs(["--render"]), { backfill: false, force: false, manual: false, render: true, mail: false, rebuild: null });
  assert.deepEqual(parseArgs(["--backfill", "--force", "--manual"]), {
    backfill: true,
    force: true,
    manual: true,
    render: false,
    mail: false,
    rebuild: null,
  });
  assert.deepEqual(parseArgs(["--rebuild="]).rebuild, [], "an empty list is passed through for runRebuild to reject");
});
