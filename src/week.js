// src/week.js — week windower (TECH §3 "week windower", §10 weekId contract).
//
// Asia/Shanghai is a fixed UTC+8 offset with no DST, so all windowing is integer
// math on epoch milliseconds — no timezone library, zero dependencies.
//
//   dayIdx      = floor((epochMs + 8h) / 24h)          days since 1970-01-01 in CST
//   dow         = (dayIdx + 4) % 7                      0=Sun..6=Sat (1970-01-01 = Thu)
//   weekStartMs = (dayIdx - ((dow + 6) % 7)) * 24h - 8h Monday 00:00 CST of that week
//
// weekId = the window's Monday as YYYY-MM-DD (Asia/Shanghai) — the primary key
// everywhere (data/weeks/<weekId>.json, page URL weeks/<weekId>.html). No ISO week
// numbers, so week-year boundaries never trap.

export const MS_DAY = 86_400_000;
export const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const EN_DASH = "–";

/** Days since 1970-01-01 in the CST calendar. */
function cstDayIdx(epochMs) {
  return Math.floor((epochMs + CST_OFFSET_MS) / MS_DAY);
}

/** 0=Sun..6=Sat, CST — matches JS Date.getDay() semantics. */
export function dowOf(epochMs) {
  return (cstDayIdx(epochMs) + 4) % 7;
}

/** Weekday label ("Mon".."Sun") in CST. */
export function weekdayOf(epochMs) {
  return WEEKDAYS[dowOf(epochMs)];
}

/** Epoch ms of Monday 00:00:00.000 CST for the week containing epochMs (inclusive start). */
export function weekStartMs(epochMs) {
  const dayIdx = cstDayIdx(epochMs);
  const dow = (dayIdx + 4) % 7; // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7; // 0=Mon..6=Sun
  return (dayIdx - daysSinceMonday) * MS_DAY - CST_OFFSET_MS;
}

/** Format an epoch as its CST calendar date, YYYY-MM-DD. */
export function cstDateString(epochMs) {
  const d = new Date(epochMs + CST_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Full ISO8601 timestamp with the fixed +08:00 offset (no timezone lib). */
export function cstIso(epochMs) {
  const d = new Date(epochMs + CST_OFFSET_MS);
  const p = (n, len = 2) => String(n).padStart(len, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+08:00`
  );
}

/** weekId (the CST Monday, YYYY-MM-DD) of the week containing epochMs. */
export function weekIdOf(epochMs) {
  return cstDateString(weekStartMs(epochMs));
}

/** Display label for a date span. "May 25–31" (same month) / "Jun 29 – Jul 5" (cross month). */
export function weekLabel(startDate, endDate) {
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  const sMon = MONTHS[sm - 1];
  const eMon = MONTHS[em - 1];
  if (sy === ey && sm === em) return `${sMon} ${sd}${EN_DASH}${ed}`;
  return `${sMon} ${sd} ${EN_DASH} ${eMon} ${ed}`;
}

/**
 * The full window for the week containing epochMs.
 * @returns {{weekId,startMs,endMs,startDate,endDate,weekLabel}} endMs is exclusive.
 */
export function weekWindow(epochMs) {
  const startMs = weekStartMs(epochMs);
  const endMs = startMs + 7 * MS_DAY; // exclusive: next Monday 00:00 CST
  const startDate = cstDateString(startMs);
  const endDate = cstDateString(endMs - MS_DAY); // Sunday
  return {
    weekId: startDate,
    startMs,
    endMs,
    startDate,
    endDate,
    weekLabel: weekLabel(startDate, endDate),
  };
}

/** Membership test: does a lesson epoch fall in weekId's [Mon 00:00, next Mon 00:00) window? */
export function isInWeek(epochMs, weekId) {
  return weekIdOf(epochMs) === weekId;
}

/** Epoch ms of Monday 00:00 CST for a weekId string, snapped defensively to a Monday. */
export function weekIdToStartMs(weekId) {
  const [y, m, d] = weekId.split("-").map(Number);
  const midnightCst = Date.UTC(y, m - 1, d) - CST_OFFSET_MS;
  return weekStartMs(midnightCst); // snap to Monday even if a non-Monday id slips in
}

/** Resolve "now" honoring the FAKE_NOW clock seam (epoch ms or ISO string). */
export function resolveNow() {
  const raw = process.env.FAKE_NOW;
  if (raw === undefined || raw === "") return Date.now();
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && /^\d+$/.test(raw.trim())) return asNum;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * The most-recent COMPLETE week as of nowMs — the week that has fully ended.
 * For a Monday run (Sun 23:30 UTC = Mon 07:30 CST) this is the prior Mon–Sun window.
 */
export function targetWeekWindow(nowMs = resolveNow()) {
  const currentStart = weekStartMs(nowMs); // Monday of the in-progress week
  return weekWindow(currentStart - 7 * MS_DAY); // any ms inside the prior week
}

export function targetWeekId(nowMs = resolveNow()) {
  return targetWeekWindow(nowMs).weekId;
}

/** Inclusive list of weekIds (CST Mondays) from fromWeekId..toWeekId. */
export function weekIdsBetween(fromWeekId, toWeekId) {
  const out = [];
  const end = weekIdToStartMs(toWeekId);
  for (let ms = weekIdToStartMs(fromWeekId); ms <= end; ms += 7 * MS_DAY) {
    out.push(cstDateString(ms));
  }
  return out;
}

/** Every complete week (Mondays) from firstWeekId up to and including the target week. */
export function completeWeekIds(firstWeekId, nowMs = resolveNow()) {
  return weekIdsBetween(firstWeekId, targetWeekId(nowMs));
}

/**
 * Missed-week self-healing set (TECH §3 windower):
 *   build set = { every complete week >= firstWeek with no week file } ∪ { target week }.
 * A failed Monday is repaired automatically by the next successful run; past empty weeks
 * still get built (as isEmpty:true stubs by the builder). Weeks before firstWeek and the
 * in-progress week are excluded. The run-wrapper owns the already-built-target short-circuit
 * (it consults `targetAlreadyBuilt`); --force re-includes the target for a deliberate rebuild.
 *
 * The already-built-target short-circuit also requires the raw lesson set to be
 * UNCHANGED (§3 windower, U-MW⑦): when both `targetLessonIds` (the current listing
 * for the target week) and `builtLessonIds` (the lessonIds recorded in the existing
 * VM) are supplied and they differ as sets, the target is rebuilt even without
 * --force — so a lesson that arrives after the week was first built is incorporated.
 *
 * @param {{firstWeekId:string, existingWeekIds?:string[], nowMs?:number, force?:boolean,
 *   targetLessonIds?:string[], builtLessonIds?:string[]}} args
 * @returns {{target:string, missed:string[], complete:string[], buildSet:string[], targetAlreadyBuilt:boolean}}
 */
export function computeBuildSet({
  firstWeekId,
  existingWeekIds = [],
  nowMs = resolveNow(),
  force = false,
  targetLessonIds,
  builtLessonIds,
}) {
  const target = targetWeekId(nowMs);
  const complete = weekIdsBetween(firstWeekId, target);
  const have = new Set(existingWeekIds);

  // Backfill weeks = complete weeks (excluding the target) that have no VM file yet.
  const missed = complete.filter((w) => w !== target && !have.has(w));

  // The target is always in the build set; whether it is short-circuited is the
  // run-wrapper's decision, surfaced here as targetAlreadyBuilt.
  const buildSet = [...new Set([...missed, target])].sort();

  let targetAlreadyBuilt = have.has(target) && !force;
  if (targetAlreadyBuilt && Array.isArray(targetLessonIds) && Array.isArray(builtLessonIds)) {
    const a = new Set(targetLessonIds);
    const b = new Set(builtLessonIds);
    const sameSet = a.size === b.size && [...a].every((id) => b.has(id));
    if (!sameSet) targetAlreadyBuilt = false; // raw lesson set changed → rebuild
  }

  return {
    target,
    missed,
    complete,
    buildSet,
    targetAlreadyBuilt,
  };
}
