// src/schedule.js — the NEXT-WEEK schedule + weekly quota block (WeekVM.nextWeek).
//
// Builder-owned and LLM-free: the week after the recap week, every lesson Cambly has
// scheduled inside it (done · confirmed; cancelled ones are dropped) and the weekly plan
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

/** The window of the week AFTER `window` (which may be a weekWindow or any {startMs}). */
export function weekAfter(window) {
  return weekWindow(window.startMs + 7 * MS_DAY);
}

function lessonState(rec) {
  if (rec.cancelledBy) return "cancelled";
  return rec.state === "done" || rec.state === "confirmed" ? rec.state : "other";
}

const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);
const strOrNull = (v) => (typeof v === "string" && v.trim() ? v : null);

/**
 * Compose WeekVM.nextWeek from the raw listing records + user record. Pure.
 * @param {{window:{startMs:number}, records:object[], user:object|null, tutorsMap?:object, now:number}} args
 */
export function buildNextWeek({ window, records, user, tutorsMap = {}, now }) {
  const win = weekAfter(window);
  const lessons = (Array.isArray(records) ? records : [])
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
  const u = user && typeof user === "object" ? unwrap(user) : null;
  const si = u && u.subscriptionInfo && typeof u.subscriptionInfo === "object" ? u.subscriptionInfo : null;
  const quota = {
    lessonsPerWeek: posInt(si?.daysPerWeek) ?? posInt(u?.planPerWeek),
    minutesPerLesson: posInt(si?.minutesPerDay),
    tier: strOrNull(si?.tutoringTier),
    planType: strOrNull(si?.type) ?? strOrNull(u?.planType),
  };
  return {
    weekId: win.weekId,
    weekLabel: win.weekLabel,
    startDate: win.startDate,
    endDate: win.endDate,
    fetchedAt: cstIso(now),
    lessons,
    quota,
  };
}

/** Both raw pieces, non-fatally. null when the listing itself is unavailable. */
export async function fetchNextWeekRaw({ base, uid, headers, window, ...net }) {
  const win = weekAfter(window);
  const opts = { ...net, headers, fatal: false };
  const listing = await fetchEndpoint(weekListingUrl(base, uid, win.startMs, win.endMs), { ...opts, label: "next-week listing" });
  if (!listing.ok) return null;
  const records = Array.isArray(listing.json?.result) ? listing.json.result : [];
  const user = await fetchEndpoint(userUrl(base, uid), { ...opts, label: "user" });
  return { records, user: user.ok ? user.json : null };
}

/**
 * ONLINE: attach/refresh `nextWeek` on one published week's VM. Names any tutor the map
 * does not know yet (and persists it). Never throws — a failure logs and leaves the VM alone.
 * @returns {Promise<boolean>} true when the VM was rewritten
 */
export async function refreshNextWeek({ dataDir, fsImpl, weekId, base, uid, headers, tutorsMap = {}, now, log = () => {}, netOpts = {} }) {
  const vm = readWeekVM(dataDir, weekId, fsImpl);
  if (!vm || vm.isEmpty === true) return false;
  const window = weekWindow(weekIdToStartMs(weekId));
  let raw;
  let map = tutorsMap;
  try {
    raw = await fetchNextWeekRaw({ base, uid, headers, window, ...netOpts });
    if (!raw) {
      log(`next-week schedule for ${weekId} skipped: listing unavailable`);
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
    log(`next-week schedule for ${weekId} skipped: ${err?.message ?? err}`);
    return false;
  }
  const nextWeek = buildNextWeek({ window, records: raw.records, user: raw.user, tutorsMap: map, now });
  writeWeekVM(dataDir, weekId, { ...vm, nextWeek }, fsImpl);
  log(`next-week schedule for ${weekId}: ${nextWeek.lessons.length} lesson(s) in ${nextWeek.weekLabel}`);
  return true;
}
