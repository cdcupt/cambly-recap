// tests/week.test.js — U-WK: week windower (TECH §3, §10, Q2 U-WK ①–⑧).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MS_DAY,
  weekIdOf,
  weekStartMs,
  weekWindow,
  weekLabel,
  weekdayOf,
  dowOf,
  cstIso,
  weekIdToStartMs,
  targetWeekWindow,
  targetWeekId,
  weekIdsBetween,
} from "../src/week.js";

import {
  realFixturesSkip,
  presentLessonDirs,
  realEpochOf,
  EXPECTED_WEEK,
  EXPECTED_WEEK_IDS,
} from "./fixtures-real.js";

// Anchor epochs (constructed via Date.UTC so the test is timezone-agnostic).
const WED_2026_05_13_1800_CST = Date.UTC(2026, 4, 13, 10, 0, 0); // 18:00 CST Wed
const MON_2026_05_11_START = weekIdToStartMs("2026-05-11"); // Mon 00:00 CST

test("U-WK① mid-week Wed CST lesson maps to that week's Monday weekId", () => {
  // Act
  const weekId = weekIdOf(WED_2026_05_13_1800_CST);

  // Assert
  assert.equal(weekId, "2026-05-11");
  assert.equal(weekdayOf(WED_2026_05_13_1800_CST), "Wed");
});

test("U-WK② Monday 00:00:00 CST is the inclusive start of its own week", () => {
  // Arrange / Act
  const startMs = weekStartMs(MON_2026_05_11_START);

  // Assert — the Monday-midnight epoch is its own week start, dow=Mon(1)
  assert.equal(startMs, MON_2026_05_11_START);
  assert.equal(weekIdOf(MON_2026_05_11_START), "2026-05-11");
  assert.equal(dowOf(MON_2026_05_11_START), 1);
  assert.equal(weekWindow(MON_2026_05_11_START).startMs, MON_2026_05_11_START);
});

test("U-WK③ Sunday 23:59:59.999 CST stays in the same week; next Monday 00:00 is the exclusive end", () => {
  // Arrange
  const sundayLastMs = MON_2026_05_11_START + 7 * MS_DAY - 1; // Sun 23:59:59.999 CST
  const nextMondayMs = MON_2026_05_11_START + 7 * MS_DAY; // Mon 00:00 CST (exclusive)

  // Assert
  assert.equal(weekIdOf(sundayLastMs), "2026-05-11");
  assert.equal(weekIdOf(nextMondayMs), "2026-05-18");
  assert.equal(weekWindow(MON_2026_05_11_START).endMs, nextMondayMs);
});

test("U-WK④ UTC/CST divergence: Mon 00:00 CST (= Sun 16:00 UTC) is assigned by CST, not UTC", () => {
  // Arrange — the Monday-midnight-CST epoch is a Sunday in UTC
  const utc = new Date(MON_2026_05_11_START);
  assert.equal(utc.getUTCDay(), 0, "precondition: Sunday in UTC");
  assert.equal(utc.getUTCHours(), 16, "precondition: 16:00 UTC");

  // Assert — windowing keys on CST, so this belongs to the 05-11 week, not 05-04
  assert.equal(weekIdOf(MON_2026_05_11_START), "2026-05-11");
});

test("U-WK⑤ year-boundary week keeps its December Monday (no ISO week-year trap)", () => {
  // Arrange — a lesson on Wed 2025-12-31, in the week of Mon 2025-12-29
  const inWeek = Date.UTC(2025, 11, 31, 4, 0, 0); // 12:00 CST
  // Act
  const w = weekWindow(inWeek);
  // Assert
  assert.equal(w.weekId, "2025-12-29");
  assert.equal(w.startDate, "2025-12-29");
  assert.equal(w.endDate, "2026-01-04");
  assert.equal(w.weekLabel, "Dec 29 – Jan 4");
});

test("U-WK⑥ a Sun 23:30 UTC run targets the prior Mon–Sun week", () => {
  // Arrange — cron fires Sun 23:30 UTC = Mon 07:30 CST (2026-06-08)
  const nowMs = Date.UTC(2026, 5, 7, 23, 30, 0);

  // Act
  const target = targetWeekWindow(nowMs);

  // Assert — the just-ended week, not the in-progress 06-08 week
  assert.equal(target.weekId, "2026-06-01");
  assert.equal(target.startDate, "2026-06-01");
  assert.equal(target.endDate, "2026-06-07");
  assert.equal(dowOf(target.startMs), 1, "target starts on a Monday");
  assert.equal(targetWeekId(nowMs), "2026-06-01");
});

test("U-WK⑦ weekLabel: same month is compact; month-spanning uses spaced dash + both months", () => {
  assert.equal(weekLabel("2026-05-25", "2026-05-31"), "May 25–31");
  assert.equal(weekLabel("2026-06-29", "2026-07-05"), "Jun 29 – Jul 5");
});

test("cstIso emits a fixed +08:00 offset without a timezone library", () => {
  assert.equal(cstIso(1778639400000), "2026-05-13T10:30:00+08:00");
});

test("weekIdsBetween is an inclusive list of CST Mondays", () => {
  assert.deepEqual(weekIdsBetween("2026-05-04", "2026-06-01"), [
    "2026-05-04",
    "2026-05-11",
    "2026-05-18",
    "2026-05-25",
    "2026-06-01",
  ]);
});

test(
  "U-WK⑧ all archived lesson epochs map to the 5 expected weekIds",
  { skip: realFixturesSkip() },
  () => {
    // Arrange
    const dirs = presentLessonDirs();
    assert.ok(dirs.length > 0, "expected at least one archived lesson dir");

    // Act + Assert per lesson
    const seen = new Set();
    for (const dir of dirs) {
      const epoch = realEpochOf(dir);
      assert.equal(typeof epoch, "number", `no real epoch recovered for ${dir}`);
      const weekId = weekIdOf(epoch);
      assert.equal(weekId, EXPECTED_WEEK[dir], `weekId mismatch for ${dir}`);
      assert.match(weekId, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(dowOf(weekIdToStartMs(weekId)), 1, "every weekId is a Monday");
      seen.add(weekId);
    }

    // Assert the distinct set is within the documented 5
    for (const w of seen) assert.ok(EXPECTED_WEEK_IDS.includes(w));
    if (dirs.length === Object.keys(EXPECTED_WEEK).length) {
      assert.deepEqual([...seen].sort(), [...EXPECTED_WEEK_IDS].sort());
    }
  },
);
