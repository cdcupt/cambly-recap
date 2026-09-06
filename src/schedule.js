// src/schedule.js — the SCHEDULE block (WeekVM.schedule): the weeks AFTER the recap week.
//
// Builder-owned and LLM-free. For each of the WEEKS_AHEAD weeks after the recap week
// (the one that starts the Monday the recap is published, and the one after it — so a
// reader on Sunday still sees a week that has not begun), every lesson Cambly has
// scheduled inside it (done · confirmed; cancelled ones dropped), plus the weekly plan
// from the student's own user record (subscriptionInfo: daysPerWeek × minutesPerDay).
// Fetched ONLINE only (runGenerate); the offline modes keep whatever a VM carries.

import {
  fetchEndpoint,
  weekListingUrl,
  userUrl,
  tutorsUrl,
} from "./fetch.js";
import { weekWindow, weekIdToStartMs, cstIso, MS_DAY } from "./week.js";
import { unwrap, unwrapDate, normalizeTutors, mergeTutors, lessonTutorId, tutorDisplayName } from "./normalize.js";
import { readWeekVM, writeWeekVM, persistTutorsMap } from "./tutors.js";

export const LESSON_STATES = Object.freeze(["done", "confirmed", "other"]);
export const WEEKS_AHEAD = 2;

/** The window `n` weeks after `window` (any {startMs}). */
export function weekAfter(window, n = 1) {
  return weekWindow(window.startMs + n * 7 * MS_DAY);
}

function lessonState(rec) {
  if (rec.cancelledBy) return "cancelled";
  return rec.state === "done" || rec.state === "confirmed" ? rec.state : "other";
}

const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);
const strOrNull = (v) => (typeof v === "string" && v.trim() ? v : null);

function lessonsIn(win, records, tutorsMap) {
  return (Array.isArray(records) ? records : [])
    .filter((r) => r && typeof r === "object")
    .map((r) => ({ ms: unwrapDate(r.scheduledStartAt), r }))
    .filter(({ ms }) => typeof ms === "number" && ms >= win.startMs && ms < win.endMs)
    .map(({ ms, r }) => ({
      lessonId: String(r.id ?? ""),
      startAt: cstIso(ms),
      minutes: posInt(r.scheduledMinutes),
      tutor: tutorDisplayName(tutorsMap[lessonTutorId(r)]) ?? "",
      state: lessonState(r),
    }))
    .filter((l) => l.lessonId && l.state !== "cancelled")
    .sort((a, b) => a.startAt.localeCompare(b.startAt) || a.lessonId.localeCompare(b.lessonId));
}

/**
 * Compose WeekVM.schedule from the raw listing records + user record. Pure.
 * @param {{window:{startMs:number}, records:object[], user:object|null, tutorsMap?:object, now:number, weeksAhead?:number}} args
 */
export function buildSchedule({ window, records, user, tutorsMap = {}, now, weeksAhead = WEEKS_AHEAD }) {
  const weeks = Array.from({ length: weeksAhead }, (_, i) => weekAfter(window, i + 1)).map((win) => ({
    weekId: win.weekId,
    weekLabel: win.weekLabel,
    startDate: win.startDate,
    endDate: win.endDate,
    lessons: lessonsIn(win, records, tutorsMap),
  }));
  const u = user && typeof user === "object" ? unwrap(user) : null;
  const si = u && u.subscriptionInfo && typeof u.subscriptionInfo === "object" ? u.subscriptionInfo : null;
  const quota = {
    lessonsPerWeek: posInt(si?.daysPerWeek) ?? posInt(u?.planPerWeek),
    minutesPerLesson: posInt(si?.minutesPerDay),
    tier: strOrNull(si?.tutoringTier),
    planType: strOrNull(si?.type) ?? strOrNull(u?.planType),
  };
  return { fetchedAt: cstIso(now), weeks, quota };
}

/** Both raw pieces, non-fatally. null when the listing itself is unavailable. */
export async function fetchScheduleRaw({ base, uid, headers, window, weeksAhead = WEEKS_AHEAD, ...net }) {
  const first = weekAfter(window, 1);
  const last = weekAfter(window, weeksAhead);
  const opts = { ...net, headers, fatal: false };
  const listing = await fetchEndpoint(weekListingUrl(base, uid, first.startMs, last.endMs), { ...opts, label: "schedule listing" });
  if (!listing.ok) return null;
  const records = Array.isArray(listing.json?.result) ? listing.json.result : [];
  const user = await fetchEndpoint(userUrl(base, uid), { ...opts, label: "user" });
  return { records, user: user.ok ? user.json : null };
}

/**
 * ONLINE: attach/refresh `schedule` on one published week's VM (drops a legacy `nextWeek`
 * block). Names any tutor the map does not know yet (and persists it). Never throws — a
 * failure logs and leaves the VM alone.
 * @returns {Promise<boolean>} true when the VM was rewritten
 */
export async function refreshSchedule({ dataDir, fsImpl, weekId, base, uid, headers, tutorsMap = {}, now, log = () => {}, netOpts = {} }) {
  const vm = readWeekVM(dataDir, weekId, fsImpl);
  if (!vm || vm.isEmpty === true) return false;
  const window = weekWindow(weekIdToStartMs(weekId));
  let raw;
  let map = tutorsMap;
  try {
    raw = await fetchScheduleRaw({ base, uid, headers, window, ...netOpts });
    if (!raw) {
      log(`schedule for ${weekId} skipped: listing unavailable`);
      return false;
    }
    const unknown = [...new Set(raw.records.map(lessonTutorId).filter((id) => id && !map[id]))];
    if (unknown.length) {
      const t = await fetchEndpoint(tutorsUrl(base, unknown), { ...netOpts, headers, fatal: false, label: "tutors" });
      if (t.ok) {
        const fetched = normalizeTutors(t.json);
        map = mergeTutors(map, fetched);
        persistTutorsMap(dataDir, fetched, fsImpl);
      }
    }
  } catch (err) {
    log(`schedule for ${weekId} skipped: ${err?.message ?? err}`);
    return false;
  }
  const schedule = buildSchedule({ window, records: raw.records, user: raw.user, tutorsMap: map, now });
  const { nextWeek: _legacy, ...rest } = vm;
  writeWeekVM(dataDir, weekId, { ...rest, schedule }, fsImpl);
  log(`schedule for ${weekId}: ${schedule.weeks.map((w) => `${w.lessons.length} in ${w.weekLabel}`).join(", ")}`);
  return true;
}
