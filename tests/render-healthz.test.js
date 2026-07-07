// tests/render-healthz.test.js — I-HZ healthz serializer: the ok truth table
// (ok:false iff outcome ∈ {auth-expired, fetch-failed} or emailOk:false), the
// FAKE_NOW-honored generatedAt, and the render facts passthrough.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeHealthz, serializeHealthz } from "../src/render/healthz.js";

const FACTS = { latestWeekId: "2026-05-25", weeksTotal: 3, lessonsThisWeek: 2, rejectedCount: 1 };
const NOW = Date.UTC(2026, 5, 1, 23, 30, 0); // Mon 07:30 CST

test("I-HZ-① ok truth table across all outcome × emailOk combinations", () => {
  const cases = [
    ["published", true, true],
    ["published", false, false],
    ["no-classes-this-week", true, true],
    ["no-classes-this-week", false, false],
    ["auth-expired", true, false],
    ["auth-expired", false, false],
    ["fetch-failed", true, false],
    ["fetch-failed", false, false],
  ];
  for (const [lastOutcome, emailOk, expectedOk] of cases) {
    const hz = computeHealthz({ siteState: { lastOutcome, emailOk }, facts: FACTS, nowMs: NOW });
    assert.equal(hz.ok, expectedOk, `${lastOutcome} / emailOk=${emailOk}`);
  }
});

test("computeHealthz: generatedAt honors the injected clock (Asia/Shanghai)", () => {
  const hz = computeHealthz({ siteState: { lastOutcome: "published" }, facts: FACTS, nowMs: NOW });
  assert.equal(hz.generatedAt, "2026-06-02T07:30:00+08:00");
});

test("computeHealthz: render facts + state pass through, authStale defaults false", () => {
  const hz = computeHealthz({
    siteState: { lastOutcome: "published", lastRunAt: "2026-06-02T07:30:00+08:00", authStale: true },
    facts: FACTS,
    nowMs: NOW,
  });
  assert.equal(hz.latestWeekId, "2026-05-25");
  assert.equal(hz.weeksTotal, 3);
  assert.equal(hz.lessonsThisWeek, 2);
  assert.equal(hz.rejectedCount, 1);
  assert.equal(hz.authStale, true);
  assert.equal(hz.lastRunAt, "2026-06-02T07:30:00+08:00");

  const bare = computeHealthz({ nowMs: NOW });
  assert.equal(bare.authStale, false);
  assert.equal(bare.emailOk, true);
  assert.equal(bare.weeksTotal, 0);
  assert.equal(bare.ok, true);
});

test("serializeHealthz: stable 2-space JSON with a trailing newline, no personal content", () => {
  const hz = computeHealthz({ siteState: { lastOutcome: "published" }, facts: FACTS, nowMs: NOW });
  const s = serializeHealthz(hz);
  assert.ok(s.endsWith("\n"));
  const keys = Object.keys(JSON.parse(s)).sort();
  assert.deepEqual(keys, [
    "authStale", "emailOk", "generatedAt", "lastOutcome", "lastRunAt",
    "latestWeekId", "lessonsThisWeek", "ok", "rejectedCount", "weeksTotal",
  ]);
});
