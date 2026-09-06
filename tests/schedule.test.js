// tests/schedule.test.js — WeekVM.nextWeek: the week-after window, the pure composer,
// the URL builders, the online refresh (fake fetch, temp data dir) and validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildNextWeek, weekAfter, refreshNextWeek } from "../src/schedule.js";
import { weekWindow, weekIdToStartMs } from "../src/week.js";
import { weekListingUrl, userUrl } from "../src/fetch.js";
import { validateWeek } from "../src/render/validate.js";
import { goldenWeekV2 } from "./render-fixtures.js";

const WIN = weekWindow(weekIdToStartMs("2026-08-24")); // the recap week
const NEXT = weekAfter(WIN);
const ms = (iso) => Date.parse(iso);
const rec = (id, iso, state, extra = {}) => ({ id, scheduledStartAt: { $date: ms(iso) }, scheduledMinutes: 60, state, tutorId: "t1", ...extra });
const USER = { result: { minutes: 30, planPerWeek: 5, planType: "perWeek", subscriptionInfo: { type: "perWeek", category: "private", minutesPerDay: 60, daysPerWeek: 5, tutoringTier: "premium" } } };
const NOW = ms("2026-09-06T12:00:00+08:00");
const fast = { sleep: async () => {}, backoff: [0], retries: 1 };

test("weekAfter is the Mon–Sun window right after the recap week", () => {
  assert.equal(NEXT.weekId, "2026-08-31");
  assert.equal(NEXT.weekLabel, "Aug 31 – Sep 6");
});

test("buildNextWeek keeps only lessons inside the next week, drops cancelled/undated ones, sorts by start, names tutors, maps the quota", () => {
  const records = [
    rec("late", "2026-09-07T10:00:00+08:00", "confirmed"), // the week after next → out
    rec("c", "2026-09-06T20:00:00+08:00", "confirmed"),
    rec("a", "2026-09-03T18:00:00+08:00", "done"),
    rec("x", "2026-09-05T18:00:00+08:00", "confirmed", { cancelledBy: "student" }),
    rec("b", "2026-09-04T17:30:00+08:00", "done", { tutorId: "t2" }),
    rec("early", "2026-08-30T20:00:00+08:00", "done"), // the recap week itself → out
    null,
    { id: "nodate", state: "confirmed" },
  ];
  const n = buildNextWeek({ window: WIN, records, user: USER, tutorsMap: { t1: { id: "t1", displayName: "Alex R." } }, now: NOW });
  assert.equal(n.weekId, "2026-08-31");
  assert.equal(n.weekLabel, "Aug 31 – Sep 6");
  assert.equal(n.startDate, "2026-08-31");
  assert.equal(n.endDate, "2026-09-06");
  assert.equal(n.fetchedAt, "2026-09-06T12:00:00+08:00");
  assert.deepEqual(n.lessons.map((l) => [l.lessonId, l.startAt, l.state, l.tutor, l.minutes]), [
    ["a", "2026-09-03T18:00:00+08:00", "done", "Alex R.", 60],
    ["b", "2026-09-04T17:30:00+08:00", "done", "", 60],
    ["c", "2026-09-06T20:00:00+08:00", "confirmed", "Alex R.", 60],
  ]);
  assert.deepEqual(n.quota, { lessonsPerWeek: 5, minutesPerLesson: 60, tier: "premium", planType: "perWeek" });
});

test("buildNextWeek without a user record → null quota fields; planPerWeek is the fallback plan size; odd states → 'other'", () => {
  const none = buildNextWeek({ window: WIN, records: [rec("z", "2026-09-02T10:00:00+08:00", "pending")], user: null, now: NOW });
  assert.deepEqual(none.quota, { lessonsPerWeek: null, minutesPerLesson: null, tier: null, planType: null });
  assert.equal(none.lessons[0].state, "other");
  const fallback = buildNextWeek({ window: WIN, records: [], user: { result: { planPerWeek: 3, planType: "perWeek" } }, now: NOW });
  assert.deepEqual(fallback.quota, { lessonsPerWeek: 3, minutesPerLesson: null, tier: null, planType: "perWeek" });
});

test("URL builders: the bounded week listing and the user record", () => {
  assert.equal(weekListingUrl("https://x.test/", "u1", 1, 2), "https://x.test/api/lessons_v2?studentId=u1&minScheduledStartAt=1&maxScheduledStartAt=2&limit=50&sort=1&viewAs=student&_=1");
  assert.equal(userUrl("https://x.test", "u1"), "https://x.test/api/users/u1?viewAs=student&_=1");
});

function tmpData(vm) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
  fs.mkdirSync(path.join(d, "weeks"));
  fs.writeFileSync(path.join(d, "weeks", "2026-08-24.json"), JSON.stringify(vm));
  return d;
}
const fakeFetch = (routes) => async (url) => {
  const u = new URL(url);
  const hit = Object.entries(routes).find(([p]) => u.pathname === p || u.pathname.startsWith(p));
  if (!hit) return { status: 404, text: async () => '{"status":404}' };
  return { status: 200, text: async () => JSON.stringify(hit[1]) };
};

test("refreshNextWeek writes nextWeek onto the target VM, names + persists an unknown tutor; a dead listing or an empty/missing VM leaves everything untouched", async () => {
  const vm = { schemaVersion: 1, weekId: "2026-08-24", isEmpty: false, classes: [] };
  const dir = tmpData(vm);
  const routes = {
    "/api/lessons_v2": { result: [rec("c", "2026-09-06T20:00:00+08:00", "confirmed", { tutorId: "t9" })] },
    "/api/users/": USER,
    "/api/tutors": { result: { t9: { id: "t9", displayName: "Victor" } } },
  };
  const common = { fsImpl: fs, weekId: "2026-08-24", base: "https://x.test", uid: "u1", headers: {}, now: NOW };
  assert.equal(await refreshNextWeek({ ...common, dataDir: dir, tutorsMap: {}, netOpts: { fetchImpl: fakeFetch(routes), ...fast } }), true);
  const out = JSON.parse(fs.readFileSync(path.join(dir, "weeks", "2026-08-24.json"), "utf8"));
  assert.equal(out.nextWeek.lessons[0].tutor, "Victor");
  assert.equal(out.nextWeek.quota.lessonsPerWeek, 5);
  assert.deepEqual(out.classes, [], "the rest of the VM is untouched");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "tutors.json"), "utf8")).t9.displayName, "Victor", "the new tutor is persisted");

  const dir2 = tmpData(vm);
  assert.equal(await refreshNextWeek({ ...common, dataDir: dir2, netOpts: { fetchImpl: fakeFetch({}), ...fast } }), false, "listing dead → skipped");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir2, "weeks", "2026-08-24.json"), "utf8")), vm);
  assert.equal(await refreshNextWeek({ ...common, dataDir: dir2, weekId: "2026-01-05", netOpts: { fetchImpl: fakeFetch(routes), ...fast } }), false, "no VM → skipped");
  const stubDir = tmpData({ ...vm, isEmpty: true });
  assert.equal(await refreshNextWeek({ ...common, dataDir: stubDir, netOpts: { fetchImpl: fakeFetch(routes), ...fast } }), false, "empty stub → skipped");
});

test("validateWeek accepts the nextWeek fixture and rejects a bad lesson state, a non-integer minutes and a missing quota", () => {
  assert.doesNotThrow(() => validateWeek(goldenWeekV2()));
  const bad = goldenWeekV2();
  bad.nextWeek.lessons[0].state = "maybe";
  assert.throws(() => validateWeek(bad), /nextWeek\.lessons\[0\]\.state invalid/);
  const mins = goldenWeekV2();
  mins.nextWeek.lessons[0].minutes = "60";
  assert.throws(() => validateWeek(mins), /minutes must be an integer or null/);
  const noQuota = goldenWeekV2();
  delete noQuota.nextWeek.quota;
  assert.throws(() => validateWeek(noQuota), /quota must be an object/);
  const legacy = goldenWeekV2();
  delete legacy.nextWeek;
  assert.doesNotThrow(() => validateWeek(legacy), "the block is optional");
});
