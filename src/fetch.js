// src/fetch.js — Cambly fetcher (TECH §3 "fetcher", endpoint catalog minus video).
//
// Node 22 native fetch, zero npm dependencies. Every endpoint is fetched in
// isolation with a 3-attempt retry (2s → 8s → 30s backoff). Auth expiry is a
// distinct, non-transient outcome detected by the normative predicate below.

import fs from "node:fs";
import path from "node:path";
import { weekIdOf } from "./week.js";

/** Production defaults for the env seams; read at call time so tests can inject. */
export function camblyBase() {
  return process.env.CAMBLY_BASE_URL || "https://www.cambly.com";
}
export function camblyUid() {
  const uid = process.env.CAMBLY_UID;
  if (!uid) throw new Error("CAMBLY_UID env is required");
  return uid;
}

export const CAMBLY_DOMAIN = "cambly.com";
/** Fallback when a pre-upgrade state file carries no _ua (§3 fetcher). */
export const FALLBACK_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Per-attempt backoff before retry N (there is no sleep after the final attempt). */
export const DEFAULT_BACKOFF_MS = [2000, 8000, 30000];
export const DEFAULT_RETRIES = 3;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AuthExpiredError extends Error {
  constructor(message = "auth-expired") {
    super(message);
    this.name = "AuthExpiredError";
    this.authExpired = true;
  }
}

export class FetchFailedError extends Error {
  constructor(message, { status, attempts } = {}) {
    super(message);
    this.name = "FetchFailedError";
    this.status = status;
    this.attempts = attempts;
  }
}

/**
 * Statuses on which a leading-'<' HTML body is a real Cambly login page rather than
 * a server/WAF/CDN error page. Cambly serves the logged-out login HTML with a 200
 * (or a 302 to it, which fetch follows to a 200); 401/403 are auth on their own.
 */
const AUTH_HTML_STATUSES = new Set([200, 302, 401, 403]);

/**
 * The one normative auth-expiry predicate (TECH §3, cited by §5, §7, U-AX).
 *   authExpired ⇔ status ∈ {401,403} || (leading-'<' HTML body AND status ∈ {200,302})
 * Cambly answers logged-out API calls with an HTML login page (status 200). A
 * deliberate refinement of sync.js's coarser `status >= 400`: a transient 5xx/404/429
 * is NOT auth expiry even when served as an HTML error/challenge page (Cloudflare,
 * nginx, WAF) — it is retried, then fetch-failed, instead of firing a false 🔑 alert
 * and a false amber "session expired" banner.
 */
export function isAuthExpired(status, body) {
  if (status === 401 || status === 403) return true;
  if (
    typeof body === "string" &&
    body.trim().startsWith("<") &&
    AUTH_HTML_STATUSES.has(status)
  ) {
    return true;
  }
  return false;
}

/** Parse a response body, mirroring sync.js's tolerant convention. */
function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return { __parseError: true };
  }
}

/** Cookie header from every cambly.com cookie in the saved storageState (§3 Auth). */
export function buildCookieHeader(state) {
  const cookies = state && Array.isArray(state.cookies) ? state.cookies : [];
  return cookies
    .filter(
      (c) =>
        c &&
        typeof c.name === "string" &&
        typeof c.domain === "string" &&
        c.domain.replace(/^\./, "").endsWith(CAMBLY_DOMAIN),
    )
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/** UA from the state file's top-level _ua field, else a pinned fallback + warning. */
export function resolveUserAgent(state, { warn = () => {} } = {}) {
  if (state && typeof state._ua === "string" && state._ua.trim()) return state._ua;
  warn(
    "cambly-state.json carries no _ua field — falling back to pinned Chrome UA (§3 fetcher)",
  );
  return FALLBACK_UA;
}

/** Assemble the request headers (Cookie + User-Agent) from a state file. */
export function authHeaders(state, opts = {}) {
  return {
    Cookie: buildCookieHeader(state),
    "User-Agent": resolveUserAgent(state, opts),
    Accept: "application/json",
  };
}

/**
 * Fetch one endpoint with retry, isolation, and auth-expiry detection.
 *
 * - Auth expiry (§3 predicate) throws AuthExpiredError immediately — never retried,
 *   never masked as transient. HTML mid-run means cookies died mid-run ⇒ abort.
 * - 2xx → { ok:true, status, json, body }.
 * - Any other status or a network error is transient: retry up to `retries`, then
 *   throw (fatal endpoints, i.e. the listing) or return a { __status } stub so the
 *   run degrades gracefully (non-fatal per-lesson endpoints, sync.js convention).
 *
 * @param {string} url
 * @param {object} opts
 * @returns {Promise<{ok:boolean,status:number,json?:any,body?:string,stub?:object,error?:string}>}
 */
export async function fetchEndpoint(url, opts = {}) {
  const {
    headers,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    backoff = DEFAULT_BACKOFF_MS,
    retries = DEFAULT_RETRIES,
    fatal = false,
    label = url,
    signal,
  } = opts;

  const backoffFor = (attempt) => backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 0;
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    let status;
    let body;
    try {
      const res = await fetchImpl(url, { headers, signal });
      status = res.status;
      body = await res.text();
    } catch (err) {
      // Transport/network error — transient.
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        await sleep(backoffFor(attempt));
        continue;
      }
      break;
    }

    // Auth expiry is never transient: abort the whole run, publish nothing.
    if (isAuthExpired(status, body)) {
      throw new AuthExpiredError(`auth-expired on ${label} (status ${status})`);
    }

    if (status >= 200 && status < 300) {
      return { ok: true, status, json: parseJson(body), body };
    }

    // Other error status (5xx/404/429, non-HTML body) — transient.
    lastError = new FetchFailedError(`${label} → HTTP ${status}`, { status, attempts: attempt });
    if (attempt < retries) {
      await sleep(backoffFor(attempt));
      continue;
    }
    if (fatal) throw lastError;
    return { ok: false, status, stub: { __status: status }, json: { __status: status } };
  }

  // Exhausted all attempts on network errors.
  if (fatal) {
    throw lastError instanceof Error ? lastError : new FetchFailedError("fetch failed", {});
  }
  return {
    ok: false,
    status: 0,
    stub: { __status: 0 },
    json: { __status: 0 },
    error: lastError && lastError.message,
  };
}

/** URL builders — ported 1:1 from the proven sync.js (viewAs=student, cache-buster _=1). */
export function listingUrl(base, uid, maxScheduledStartAt) {
  const b = base.replace(/\/$/, "");
  return (
    `${b}/api/lessons_v2?studentId=${uid}&maxScheduledStartAt=${maxScheduledStartAt}` +
    `&state%5B%5D=done&limit=100&sort=-1&viewAs=student&_=1`
  );
}

export function tutorsUrl(base, ids) {
  const b = base.replace(/\/$/, "");
  return `${b}/api/tutors?${ids.map((t) => `ids%5B%5D=${t}`).join("&")}&viewAs=student&_=1`;
}

/** Per-lesson endpoint catalog minus video (transcript-only per PRD). */
export function endpointUrls(base, uid, lid, lesson = {}) {
  const b = base.replace(/\/$/, "");
  const tail = "&viewAs=student&_=1";
  const urls = {
    lesson_transcript: `${b}/model/lesson_transcript/${lid}?language=en&interfaceLanguage=en&_=1`,
    talon_chats: `${b}/model/talon_chats/${lid}?language=en&interfaceLanguage=en&_=1`,
    corrective_feedback_corrections: `${b}/api/corrective_feedback_corrections?userId=${uid}&lessonId=${lid}${tail}`,
    positive_feedbacks: `${b}/api/positive_feedbacks?userId=${uid}&lessonId=${lid}${tail}`,
    ai_tutor_student_feedbacks: `${b}/api/ai_tutor_student_feedbacks?lessonIds%5B%5D=${lid}${tail}`,
    tutor_student_feedbacks: `${b}/api/tutor_student_feedbacks?studentId=${uid}&lessonId%5B%5D=${lid}${tail}`,
    user_lesson_stats: `${b}/api/user_lesson_stats?lessonId=${lid}&userId=${uid}${tail}`,
  };
  if (Array.isArray(lesson.lessonPartIds) && lesson.lessonPartIds.length) {
    urls.lesson_parts = `${b}/api/lesson_parts?${lesson.lessonPartIds
      .map((x) => `ids%5B%5D=${x}`)
      .join("&")}${tail}`;
  }
  if (lesson.lessonPlanId) {
    urls.lesson_plan = `${b}/api/lesson_plans/${lesson.lessonPlanId}?viewAs%5BviewAs%5D=student&viewAs%5Bforce%5D=false&_=1`;
  }
  return urls;
}

/**
 * Fetch the done-lesson listing. Fatal: a dead listing kills the run (nothing to
 * build). Auth expiry propagates as AuthExpiredError.
 */
export async function fetchListing(opts = {}) {
  const {
    base = camblyBase(),
    uid = camblyUid(),
    maxScheduledStartAt = Date.now(),
    ...rest
  } = opts;
  const r = await fetchEndpoint(listingUrl(base, uid, maxScheduledStartAt), {
    label: "lessons_v2",
    fatal: true,
    ...rest,
  });
  const lessons = Array.isArray(r.json?.result) ? r.json.result : [];
  return lessons.filter((l) => l && l.state === "done");
}

/**
 * Fetch every per-lesson endpoint in isolation. A dead non-listing endpoint after
 * 3 tries writes a { __status } stub into the bundle and is recorded in `degraded`;
 * an auth-expiry on any endpoint aborts the whole run (throws AuthExpiredError).
 *
 * @returns {Promise<{lessonId:string, files:Record<string,any>, degraded:string[]}>}
 */
export async function fetchLesson(lid, opts = {}) {
  const { base = camblyBase(), uid = camblyUid(), lesson = {}, ...rest } = opts;
  const urls = endpointUrls(base, uid, lid, lesson);
  const files = {};
  const degraded = [];
  for (const [name, url] of Object.entries(urls)) {
    const r = await fetchEndpoint(url, { label: name, fatal: false, ...rest });
    files[name] = r.json;
    if (!r.ok) degraded.push(name);
  }
  return { lessonId: lid, files, degraded };
}

/**
 * Fetch-level idempotence (§3): a lesson is complete iff its transcript file exists
 * and no endpoint file is a { __status } stub. Complete lessons are skipped on re-run.
 */
export function isLessonRawComplete(dir, { fsImpl = fs } = {}) {
  const transcript = path.join(dir, "lesson_transcript.json");
  if (!fsImpl.existsSync(transcript)) return false;
  let entries;
  try {
    entries = fsImpl.readdirSync(dir);
  } catch {
    return false;
  }
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    try {
      const j = JSON.parse(fsImpl.readFileSync(path.join(dir, f), "utf8"));
      if (j && typeof j === "object" && "__status" in j) return false;
    } catch {
      // Unreadable/corrupt file → treat as incomplete so a re-run repairs it.
      return false;
    }
  }
  return true;
}

/**
 * The offline lesson inventory (--rebuild): every COMPLETE raw dir under
 * `<dataDir>/raw/<lessonId>/` whose `_lesson.json` listing record carries a numeric
 * `scheduledStartAt.$date`, as {lessonId, dir, startMs, weekId}. Incomplete, undated,
 * or unreadable dirs are skipped — a rebuild only ever re-summarizes what was fully
 * fetched. Order follows the directory listing; callers sort.
 *
 * @param {string} dataDir
 * @param {{fsImpl?:object}} [deps]
 * @returns {{lessonId:string, dir:string, startMs:number, weekId:string}[]}
 */
export function listCompleteRawLessons(dataDir, { fsImpl = fs } = {}) {
  const rawDir = path.join(dataDir, "raw");
  let entries = [];
  try {
    entries = fsImpl.readdirSync(rawDir);
  } catch {
    return [];
  }
  return entries.flatMap((lid) => {
    const dir = path.join(rawDir, lid);
    if (!isLessonRawComplete(dir, { fsImpl })) return [];
    try {
      const rec = JSON.parse(fsImpl.readFileSync(path.join(dir, "_lesson.json"), "utf8"));
      const startMs = rec?.scheduledStartAt?.$date;
      if (typeof startMs !== "number" || !Number.isFinite(startMs)) return [];
      return [{ lessonId: rec.id || lid, dir, startMs, weekId: weekIdOf(startMs) }];
    } catch {
      return [];
    }
  });
}

/**
 * Backfill mode (§3 --backfill): walk the listing back by maxScheduledStartAt until
 * firstWeekStartMs, collecting every done lesson at or after the floor.
 */
export async function paginateListing(opts = {}) {
  const {
    firstWeekStartMs,
    base = camblyBase(),
    uid = camblyUid(),
    now = Date.now(),
    maxPages = 50,
    ...rest
  } = opts;
  const all = new Map();
  let cursor = now;
  for (let page = 0; page < maxPages; page++) {
    const lessons = await fetchListing({ base, uid, maxScheduledStartAt: cursor, ...rest });
    if (!lessons.length) break;
    let min = cursor;
    for (const l of lessons) {
      all.set(l.id, l);
      const t = l.scheduledStartAt?.$date;
      if (typeof t === "number" && t < min) min = t;
    }
    if (min >= cursor) break; // no backward progress → stop
    cursor = min;
    if (typeof firstWeekStartMs === "number" && min <= firstWeekStartMs) break;
  }
  return [...all.values()].filter(
    (l) =>
      typeof firstWeekStartMs !== "number" ||
      (l.scheduledStartAt?.$date ?? 0) >= firstWeekStartMs,
  );
}
