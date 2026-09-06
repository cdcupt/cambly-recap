// tests/schedule.test.js — WeekVM.schedule: the weeks-after windows, the pure composer,
// the URL builders, the online refresh (fake fetch, temp data dir) and validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildSchedule, weekAfter, refreshSchedule, WEEKS_AHEAD } from "../src/schedule.js";
import { weekWindow, weekIdToStartMs } from "../src/week.js";
import { weekListingUrl, userUrl } from "../src/fetch.js";
import { validateWeek } from "../src/render/validate.js";
import { goldenWeekV2 } from "./render-fixtures.js";

const WIN = weekWindow(weekIdToStartMs("2026-08-24")); // the recap week
const ms = (iso) => Date.parse(iso);
const rec = (id, iso, state, extra = {}) => ({ id, scheduledStartAt: { $date: ms(iso) }, scheduledMinutes: 60, state, tutorId: "t1", ...extra });
const USER = { result: { minutes: 30, planPerWeek: 5, planType: "perWeek", subscriptionInfo: { type: "perWeek", category: "private", minutesPerDay: 60, daysPerWeek: 5, tutoringTier: "premium" } } };
const NOW = ms("2026-09-06T12:00:00+08:00");
const fast = { sleep: async () => {}, backoff: [0], retries: 1 };

test("weekAfter: the n-th Mon–Sun window after the recap week; two weeks are covered by default", () => {
  assert.equal(weekAfter(WIN).weekId, "2026-08-31");
  assert.equal(weekAfter(WIN, 1).weekLabel, "Aug 31 – Sep 6");
  assert.equal(weekAfter(WIN, 2).weekLabel, "Sep 7–13");
  assert.equal(WEEKS_AHEAD, 2);
});

test("buildSchedule: one entry per week ahead, each with only its own lessons (cancelled/undated dropped, sorted, tutors named); quota from the user record", () => {
  const records = [
    rec("w3", "2026-09-15T10:00:00+08:00", "confirmed"), // third week → out
    rec("c", "2026-09-06T20:00:00+08:00", "confirmed"),
    rec("a", "2026-09-03T18:00:00+08:00", "done"),
    rec("x", "2026-09-05T18:00:00+08:00", "confirmed", { cancelledBy: "student" }),
    rec("b", "2026-09-04T17:30:00+08:00", "done", { tutorId: "t2" }),
    rec("n1", "2026-09-09T18:00:00+08:00", "confirmed"),
    rec("n2", "2026-09-13T20:00:00+08:00", "confirmed"),
    rec("early", "2026-08-30T20:00:00+08:00", "done"), // the recap week itself → out
    null,
    { id: "nodate", state: "confirmed" },
  ];
  const sc = buildSchedule({ window: WIN, records, user: USER, tutorsMap: { t1: { id: "t1", displayName: "Alex R." } }, now: NOW });
  assert.equal(sc.fetchedAt, "2026-09-06T12:00:00+08:00");
  assert.deepEqual(sc.weeks.map((w) => [w.weekId, w.weekLabel, w.startDate, w.endDate]), [
    ["2026-08-31", "Aug 31 – Sep 6", "2026-08-31", "2026-09-06"],
    ["2026-09-07", "Sep 7–13", "2026-09-07", "2026-09-13"],
  ]);
  assert.deepEqual(sc.weeks[0].lessons.map((l) => [l.lessonId, l.startAt, l.state, l.tutor, l.minutes]), [
    ["a", "2026-09-03T18:00:00+08:00", "done", "Alex R.", 60],
    ["b", "2026-09-04T17:30:00+08:00", "done", "", 60],
    ["c", "2026-09-06T20:00:00+08:00", "confirmed", "Alex R.", 60],
  ]);
  assert.deepEqual(sc.weeks[1].lessons.map((l) => l.lessonId), ["n1", "n2"]);
  assert.deepEqual(sc.quota, { lessonsPerWeek: 5, minutesPerLesson: 60, tier: "premium", planType: "perWeek" });
});

test("buildSchedule without a user record → null quota fields; planPerWeek is the fallback plan size; odd states → 'other'; weeksAhead is adjustable", () => {
  const none = buildSchedule({ window: WIN, records: [rec("z", "2026-09-02T10:00:00+08:00", "pending")], user: null, now: NOW });
  assert.deepEqual(none.quota, { lessonsPerWeek: null, minutesPerLesson: null, tier: null, planType: null });
  assert.equal(none.weeks[0].lessons[0].state, "other");
  const fallback = buildSchedule({ window: WIN, records: [], user: { result: { planPerWeek: 3, planType: "perWeek" } }, now: NOW, weeksAhead: 1 });
  assert.deepEqual(fallback.quota, { lessonsPerWeek: 3, minutesPerLesson: null, tier: null, planType: "perWeek" });
  assert.equal(fallback.weeks.length, 1);
});

test("URL builders: the bounded listing and the user record", () => {
  assert.equal(weekListingUrl("https://x.test/", "u1", 1, 2), "https://x.test/api/lessons_v2?studentId=u1&minScheduledStartAt=1&maxScheduledStartAt=2&limit=50&sort=1&viewAs=student&_=1");
  assert.equal(userUrl("https://x.test", "u1"), "https://x.test/api/users/u1?viewAs=student&_=1");
});

function tmpData(vm) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
  fs.mkdirSync(path.join(d, "weeks"));
  fs.writeFileSync(path.join(d, "weeks", "2026-08-24.json"), JSON.stringify(vm));
  return d;
}
const fakeFetch = (routes, seen = []) => async (url) => {
  const u = new URL(url);
  seen.push(u.pathname + u.search);
  const hit = Object.entries(routes).find(([p]) => u.pathname === p || u.pathname.startsWith(p));
  if (!hit) return { status: 404, text: async () => '{"status":404}' };
  return { status: 200, text: async () => JSON.stringify(hit[1]) };
};

test("refreshSchedule writes `schedule` (two weeks) onto the target VM, asks for exactly that span, drops a legacy nextWeek block, names + persists an unknown tutor; a dead listing or an empty/missing VM leaves everything untouched", async () => {
  const vm = { schemaVersion: 1, weekId: "2026-08-24", isEmpty: false, classes: [], nextWeek: { legacy: true } };
  const dir = tmpData(vm);
  const seen = [];
  const routes = {
    "/api/lessons_v2": { result: [rec("c", "2026-09-06T20:00:00+08:00", "confirmed", { tutorId: "t9" }), rec("n", "2026-09-10T18:00:00+08:00", "confirmed", { tutorId: "t9" })] },
    "/api/users/": USER,
    "/api/tutors": { result: { t9: { id: "t9", displayName: "Victor" } } },
  };
  const common = { fsImpl: fs, weekId: "2026-08-24", base: "https://x.test", uid: "u1", headers: {}, now: NOW };
  assert.equal(await refreshSchedule({ ...common, dataDir: dir, tutorsMap: {}, netOpts: { fetchImpl: fakeFetch(routes, seen), ...fast } }), true);
  const listing = seen.find((s) => s.startsWith("/api/lessons_v2"));
  assert.ok(listing.includes(`minScheduledStartAt=${weekAfter(WIN, 1).startMs}`) && listing.includes(`maxScheduledStartAt=${weekAfter(WIN, 2).endMs}`), `the listing spans exactly the two weeks ahead: ${listing}`);
  const out = JSON.parse(fs.readFileSync(path.join(dir, "weeks", "2026-08-24.json"), "utf8"));
  assert.ok(!("nextWeek" in out), "the legacy block is gone");
  assert.equal(out.schedule.weeks.length, 2);
  assert.equal(out.schedule.weeks[0].lessons[0].tutor, "Victor");
  assert.equal(out.schedule.weeks[1].lessons[0].lessonId, "n");
  assert.equal(out.schedule.quota.lessonsPerWeek, 5);
  assert.deepEqual(out.classes, [], "the rest of the VM is untouched");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "tutors.json"), "utf8")).t9.displayName, "Victor", "the new tutor is persisted");

  const dir2 = tmpData(vm);
  assert.equal(await refreshSchedule({ ...common, dataDir: dir2, netOpts: { fetchImpl: fakeFetch({}), ...fast } }), false, "listing dead → skipped");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir2, "weeks", "2026-08-24.json"), "utf8")), vm);
  assert.equal(await refreshSchedule({ ...common, dataDir: dir2, weekId: "2026-01-05", netOpts: { fetchImpl: fakeFetch(routes), ...fast } }), false, "no VM → skipped");
  const stubDir = tmpData({ ...vm, isEmpty: true });
  assert.equal(await refreshSchedule({ ...common, dataDir: stubDir, netOpts: { fetchImpl: fakeFetch(routes), ...fast } }), false, "empty stub → skipped");
});

test("validateWeek accepts the schedule fixture and rejects a bad lesson state, a non-integer minutes, an empty weeks list and a missing quota; the block is optional", () => {
  assert.doesNotThrow(() => validateWeek(goldenWeekV2()));
  const bad = goldenWeekV2();
  bad.schedule.weeks[0].lessons[0].state = "maybe";
  assert.throws(() => validateWeek(bad), /schedule\.weeks\[0\]\.lessons\[0\]\.state invalid/);
  const mins = goldenWeekV2();
  mins.schedule.weeks[1].lessons[0].minutes = "60";
  assert.throws(() => validateWeek(mins), /minutes must be an integer or null/);
  const none = goldenWeekV2();
  none.schedule.weeks = [];
  assert.throws(() => validateWeek(none), /weeks must be a non-empty array/);
  const noQuota = goldenWeekV2();
  delete noQuota.schedule.quota;
  assert.throws(() => validateWeek(noQuota), /quota must be an object/);
  const legacy = goldenWeekV2();
  delete legacy.schedule;
  assert.doesNotThrow(() => validateWeek(legacy), "the block is optional");
});
