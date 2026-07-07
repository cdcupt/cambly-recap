// src/render/healthz.js — the healthz writer (§3 · F7), shared with the renderer
// and invoked LAST every run (after the atomic swap and the mail attempt) so
// freshness reflects a completed site and emailOk is final. Output is a
// serialization of site-state.json plus a few render facts; it carries NO personal
// content, so the caddy snippet may serve exactly this one path unauthenticated.

import fs from "node:fs";
import path from "node:path";
import { resolveNow, cstIso } from "../week.js";

// Gatus goes red iff the run failed to publish or the alert email didn't send.
const BAD_OUTCOMES = new Set(["auth-expired", "fetch-failed"]);

/**
 * Build the healthz object.
 * @param {{siteState?:object, facts?:object, nowMs?:number}} args
 * @returns {{ok:boolean, generatedAt:string, lastRunAt:*, lastOutcome:*,
 *   latestWeekId:*, weeksTotal:number, lessonsThisWeek:number, rejectedCount:number,
 *   emailOk:boolean, authStale:boolean}}
 */
export function computeHealthz({ siteState = {}, facts = {}, nowMs = resolveNow() } = {}) {
  const lastOutcome = siteState.lastOutcome ?? null;
  const emailOk = siteState.emailOk !== false; // absent/true → true
  const ok = !(BAD_OUTCOMES.has(lastOutcome) || emailOk === false);
  return {
    ok,
    generatedAt: cstIso(nowMs),
    lastRunAt: siteState.lastRunAt ?? null,
    lastOutcome,
    latestWeekId: facts.latestWeekId ?? null,
    weeksTotal: facts.weeksTotal ?? 0,
    lessonsThisWeek: facts.lessonsThisWeek ?? 0,
    rejectedCount: facts.rejectedCount ?? 0,
    emailOk,
    authStale: siteState.authStale === true,
  };
}

/** Serialize healthz to a stable JSON string (2-space indent, trailing newline). */
export function serializeHealthz(healthz) {
  return JSON.stringify(healthz, null, 2) + "\n";
}

/**
 * Write healthz.json into siteDir. Called as the run's final /site write.
 * @param {string} siteDir
 * @param {object} args - forwarded to computeHealthz
 * @param {{fsImpl?:object}} [deps]
 * @returns {object} the healthz object that was written
 */
export function writeHealthz(siteDir, args = {}, { fsImpl = fs } = {}) {
  const healthz = computeHealthz(args);
  fsImpl.writeFileSync(path.join(siteDir, "healthz.json"), serializeHealthz(healthz));
  return healthz;
}
