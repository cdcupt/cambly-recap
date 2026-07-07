// tests/missed-week.test.js — U-MW: missed-week computation (TECH §3 windower, Q2 U-MW ①–⑥).
//
// The pure set computation lives in src/week.js (week math); the run-wrapper owns
// the already-built-target email/summarize short-circuit and consults the flags here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeBuildSet, completeWeekIds, resolveNow, targetWeekId } from "../src/week.js";

// A Monday-run clock: Sun 23:30 UTC = Mon 2026-06-08 07:30 CST → target week 2026-06-01.
const MONDAY_RUN = Date.UTC(2026, 5, 7, 23, 30, 0);
const FIRST_WEEK = "2026-05-04";
const ALL_COMPLETE = ["2026-05-04", "2026-05-11", "2026-05-18", "2026-05-25", "2026-06-01"];

test("U-MW① all week files present → build set is just the target", () => {
  const r = computeBuildSet({
    firstWeekId: FIRST_WEEK,
    existingWeekIds: ALL_COMPLETE,
    nowMs: MONDAY_RUN,
  });
  assert.equal(r.target, "2026-06-01");
  assert.deepEqual(r.missed, []);
  assert.deepEqual(r.buildSet, ["2026-06-01"]);
  assert.equal(r.targetAlreadyBuilt, true);
});

test("U-MW② one gap → {gap, target}", () => {
  const r = computeBuildSet({
    firstWeekId: FIRST_WEEK,
    existingWeekIds: ["2026-05-04", "2026-05-11", "2026-05-25", "2026-06-01"], // missing 05-18
    nowMs: MONDAY_RUN,
  });
  assert.deepEqual(r.missed, ["2026-05-18"]);
  assert.deepEqual(r.buildSet, ["2026-05-18", "2026-06-01"]);
});

test("U-MW③ multiple gaps → every complete week ≥ FIRST_WEEK lacking a file", () => {
  const r = computeBuildSet({
    firstWeekId: FIRST_WEEK,
    existingWeekIds: ["2026-05-25", "2026-06-01"],
    nowMs: MONDAY_RUN,
  });
  assert.deepEqual(r.missed, ["2026-05-04", "2026-05-11", "2026-05-18"]);
  assert.deepEqual(r.buildSet, ["2026-05-04", "2026-05-11", "2026-05-18", "2026-06-01"]);
});

test("U-MW④ weeks before FIRST_WEEK are excluded", () => {
  const r = computeBuildSet({
    firstWeekId: FIRST_WEEK,
    existingWeekIds: [],
    nowMs: MONDAY_RUN,
  });
  assert.equal(r.complete[0], "2026-05-04");
  assert.ok(!r.buildSet.some((w) => w < "2026-05-04"));
  assert.ok(!r.buildSet.includes("2026-04-27"));
});

test("U-MW⑤ the in-progress week is excluded (complete weeks only)", () => {
  const r = computeBuildSet({
    firstWeekId: FIRST_WEEK,
    existingWeekIds: [],
    nowMs: MONDAY_RUN,
  });
  // 2026-06-08 is the week the run fires in — never a build target
  assert.equal(r.complete.at(-1), "2026-06-01");
  assert.ok(!r.buildSet.includes("2026-06-08"));
  assert.equal(completeWeekIds(FIRST_WEEK, MONDAY_RUN).at(-1), "2026-06-01");
});

test("U-MW⑥ an empty gap week is still built, so later runs stop re-listing it", () => {
  // The set computation cannot know a week is empty; it schedules the gap week and
  // the builder writes an isEmpty:true stub. Once a file exists it drops out of `missed`.
  const before = computeBuildSet({
    firstWeekId: FIRST_WEEK,
    existingWeekIds: ["2026-05-04", "2026-05-11", "2026-05-25", "2026-06-01"],
    nowMs: MONDAY_RUN,
  });
  assert.ok(before.buildSet.includes("2026-05-18"));

  const after = computeBuildSet({
    firstWeekId: FIRST_WEEK,
    existingWeekIds: ALL_COMPLETE, // now the stub exists
    nowMs: MONDAY_RUN,
  });
  assert.ok(!after.missed.includes("2026-05-18"));
});

test("U-MW⑦(seam) --force re-includes an already-built target", () => {
  const plain = computeBuildSet({
    firstWeekId: FIRST_WEEK,
    existingWeekIds: ALL_COMPLETE,
    nowMs: MONDAY_RUN,
  });
  const forced = computeBuildSet({
    firstWeekId: FIRST_WEEK,
    existingWeekIds: ALL_COMPLETE,
    nowMs: MONDAY_RUN,
    force: true,
  });
  assert.equal(plain.targetAlreadyBuilt, true);
  assert.equal(forced.targetAlreadyBuilt, false);
  assert.ok(forced.buildSet.includes("2026-06-01"));
});

test("U-MW⑦ a changed raw lesson set rebuilds the already-built target even without --force", () => {
  const unchanged = computeBuildSet({
    firstWeekId: FIRST_WEEK,
    existingWeekIds: ALL_COMPLETE,
    nowMs: MONDAY_RUN,
    targetLessonIds: ["L1", "L2"],
    builtLessonIds: ["L2", "L1"], // same set, order-insensitive
  });
  assert.equal(unchanged.targetAlreadyBuilt, true); // unchanged set → still short-circuited

  const changed = computeBuildSet({
    firstWeekId: FIRST_WEEK,
    existingWeekIds: ALL_COMPLETE,
    nowMs: MONDAY_RUN,
    targetLessonIds: ["L1", "L2", "L3"], // a lesson arrived after the week was first built
    builtLessonIds: ["L1", "L2"],
  });
  assert.equal(changed.targetAlreadyBuilt, false); // changed set → rebuild without --force
  assert.ok(changed.buildSet.includes("2026-06-01"));
});

test("FAKE_NOW seam drives the target-week clock", () => {
  const saved = process.env.FAKE_NOW;
  try {
    process.env.FAKE_NOW = String(MONDAY_RUN);
    assert.equal(resolveNow(), MONDAY_RUN);
    assert.equal(targetWeekId(), "2026-06-01");

    // ISO form is accepted too
    process.env.FAKE_NOW = "2026-06-07T23:30:00Z";
    assert.equal(targetWeekId(), "2026-06-01");
  } finally {
    if (saved === undefined) delete process.env.FAKE_NOW;
    else process.env.FAKE_NOW = saved;
  }
});
