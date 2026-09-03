// src/run.js — run wrapper / container entrypoint (TECH §3 "run wrapper", §4 · §5 · §7).
//
// Single entry: fetch → normalize → summarize → build → render → mail → healthz →
// runs.ndjson. Every run terminates in EXACTLY ONE of the four PRD outcomes, each
// with its own exit code (§5):
//
//   published   (0)  — target week has ≥1 lesson; site rebuilt + 📗 email
//   no-classes  (0)  — target week has 0 lessons; isEmpty stub + 📭 email
//   auth-expired(3)  — the §3 predicate fired; amber banner re-render + 🔑 email
//   fetch-failed(2)  — listing/summarize/build/render failed after retries; ⚠️ email
//
// Cross-cutting behaviour: missed-week self-heal (build every complete week ≥
// FIRST_WEEK lacking a VM file), --backfill (summarize ALL historical weeks — PM
// approved full depth), site-state.json written after every run, healthz.json
// written LAST (after the mail attempt so emailOk is final), atomic site swap
// (delegated to the renderer), and idempotent re-runs — an already-built target
// makes zero LLM calls and sends zero emails.
//
// Tutors (v2): /api/tutors answers an OBJECT map keyed by id → normalized to the flat map
// {id: {id, displayName}}, merged into data/tutors.json (never shrinks), used to name each
// lesson's tutor and to self-heal published VMs with an empty tutor (patchTutorNames —
// the map + self-heal helpers live in src/tutors.js and are re-exported below).
// Offline modes (v2): --rebuild=<weekId>[,…] re-summarizes weeks from complete data/raw
// dirs (LLM yes, Cambly no, mail only with --mail); --render re-renders with zero LLM and
// zero network. Neither rewrites site-state.json.
//
// Env seams (all honoured here): CAMBLY_BASE_URL, OPENAI_BASE_URL, RESEND_BASE_URL,
// DATA_DIR, SITE_DIR, FAKE_NOW, OPENAI_MODEL, FIRST_WEEK, CAMBLY_STATE_PATH,
// MAIL_FROM/MAIL_TO/SITE_URL. Week math is Asia/Shanghai (src/week.js).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  fetchListing,
  fetchLesson,
  paginateListing,
  fetchEndpoint,
  tutorsUrl,
  authHeaders,
  isLessonRawComplete,
  listCompleteRawLessons,
  camblyBase,
  camblyUid,
  AuthExpiredError,
} from "./fetch.js";
import {
  resolveNow,
  targetWeekId,
  weekWindow,
  weekIdToStartMs,
  computeBuildSet,
  isInWeek,
  cstIso,
  cstDateString,
} from "./week.js";
import {
  normalizeLessonDir,
  normalizeTutors,
  lessonTutorId,
  ENDPOINT_FILES as RAW_FILES,
} from "./normalize.js";
import {
  listExistingWeekIds,
  readWeekVM,
  writeWeekVM,
  readTutorsMap,
  persistTutorsMap,
  patchTutorNames,
} from "./tutors.js";
import { generateWeekVM } from "./build.js";
import { openaiBase, openaiKey, openaiModel, summarizeWeek } from "./summarize.js";
import { buildSite, readWeeks, readSiteState, computeFacts } from "./render/site.js";
import { writeHealthz } from "./render/healthz.js";
import { OUTCOME, RECOVERY_COMMANDS, sendEmail, siteUrl } from "./mail.js";

// Re-exported for the callers/tests that import the tutor self-heal from the run wrapper.
export { patchTutorNames };

const SCHEMA_VERSION = 1;
const STATE_PATH_DEFAULT = "/secrets/cambly-state.json";
const WEEK_ID_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── on-disk helpers (all take an injectable fsImpl for tests) ────────────────────

function loadCamblyState(fsImpl, statePath, log) {
  const p = statePath ?? process.env.CAMBLY_STATE_PATH ?? STATE_PATH_DEFAULT;
  try {
    return JSON.parse(fsImpl.readFileSync(p, "utf8"));
  } catch {
    log(`no readable cambly-state at ${p}; sending empty auth headers`);
    return {};
  }
}

/** Write a lesson's raw dir; tutors.json carries {result: <the lesson's slice of the tutors map>}. */
function writeRaw(dir, files, rec, tutorsMap, fsImpl) {
  const tid = lessonTutorId(rec);
  const subset = tid && tutorsMap[tid] ? { [tid]: tutorsMap[tid] } : {};
  fsImpl.mkdirSync(dir, { recursive: true });
  fsImpl.writeFileSync(path.join(dir, "_lesson.json"), JSON.stringify(rec, null, 2));
  fsImpl.writeFileSync(path.join(dir, "tutors.json"), JSON.stringify({ result: subset }, null, 2));
  for (const [name, fname] of Object.entries(RAW_FILES)) {
    if (name in files) fsImpl.writeFileSync(path.join(dir, fname), JSON.stringify(files[name], null, 2));
  }
}

/** site-state.json — the one state file the renderer (banner) and healthz serialize from (§3). */
function makeSiteState({ outcome, nowMs, authStale, authStaleSince, emailOk }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    lastRunAt: cstIso(nowMs),
    lastOutcome: outcome,
    authStale,
    authStaleSince: authStale ? authStaleSince : null,
    emailOk,
    recoveryCommands: [...RECOVERY_COMMANDS],
  };
}

function writeSiteState(dataDir, state, fsImpl) {
  fsImpl.mkdirSync(dataDir, { recursive: true });
  fsImpl.writeFileSync(path.join(dataDir, "site-state.json"), JSON.stringify(state, null, 2) + "\n");
}

function appendRunLog(dataDir, entry, fsImpl) {
  fsImpl.mkdirSync(dataDir, { recursive: true });
  fsImpl.appendFileSync(path.join(dataDir, "runs.ndjson"), JSON.stringify(entry) + "\n");
}

/** One runs.ndjson entry — the same shape for every mode (cron/backfill/manual/rebuild/render). */
function runLogEntry({ nowMs, trigger, result, weeksBuilt, lessonsFetched = 0, rejects = 0, backfilled = 0, emailOk, tutorsPatched = 0, durationMs }) {
  return {
    at: cstIso(nowMs),
    trigger,
    outcome: result.outcome,
    weeksBuilt,
    lessonsFetched,
    rejects,
    backfilled,
    emailOk,
    tutorsPatched,
    durationMs: Math.max(0, durationMs),
    error: result.error ? `${result.error.name}: ${result.error.message}` : null,
  };
}

// ── network helpers ──────────────────────────────────────────────────────────────

/**
 * /api/tutors?ids[]=… → the flat tutors map. The live endpoint answers an OBJECT map keyed
 * by id ({result: {"<id>": {…}}}); older captures were arrays — both accepted. Dead → {}.
 */
async function fetchTutors(ids, ctx) {
  if (!ids.length) return {};
  const { base, headers, fetchImpl, sleep, backoff, retries } = ctx;
  const netOpts = { label: "tutors", fatal: false, headers, fetchImpl, sleep, backoff, retries };
  const r = await fetchEndpoint(tutorsUrl(base, ids), netOpts);
  return r.ok ? normalizeTutors(r.json) : {};
}

/**
 * Ensure a lesson's raw dir exists (fetch-level idempotence: a complete dir is never
 * re-fetched) and return the normalized lesson. Auth expiry on any endpoint throws
 * AuthExpiredError up to the run's outcome selector.
 */
async function ensureRawAndNormalize(rec, ctx) {
  const { dataDir, base, uid, headers, tutorsMap, fsImpl, netOpts, degraded } = ctx;
  const lid = rec.id;
  const dir = path.join(dataDir, "raw", lid);
  let fetched = false;
  let lessonDegraded = [];
  if (!isLessonRawComplete(dir, { fsImpl })) {
    const res = await fetchLesson(lid, { base, uid, lesson: rec, headers, ...netOpts });
    lessonDegraded = res.degraded;
    for (const d of res.degraded) degraded.add(d);
    writeRaw(dir, res.files, rec, tutorsMap, fsImpl);
    fetched = true;
  }
  const lesson = normalizeLessonDir(dir, { fsImpl, uid, lesson: rec, tutors: tutorsMap });
  return { lesson, fetched, degraded: lessonDegraded };
}

/** The corrections endpoint is the Σ anchor: a dead one can't be told from "0 corrections". */
const CORRECTIONS_ENDPOINT = "corrective_feedback_corrections";

/** The FIRST_WEEK floor (a YYYY-MM-DD env value), or null when unset / malformed. */
function firstWeekFloor() {
  const raw = process.env.FIRST_WEEK;
  return typeof raw === "string" && WEEK_ID_RE.test(raw.trim()) ? raw.trim() : null;
}

/** FIRST_WEEK bounds the missed-week self-heal; default = target-only when unset. */
function resolveFirstWeekId(nowMs) {
  return firstWeekFloor() ?? targetWeekId(nowMs);
}

// ── email context assembly (feeds mail.renderEmail) ──────────────────────────────

function mailCtx(outcome, x) {
  const base = siteUrl();
  if (outcome === OUTCOME.PUBLISHED || outcome === OUTCOME.NO_CLASSES) {
    const vm = x.targetVM || {};
    return {
      weekId: x.target,
      weekLabel: vm.weekLabel ?? x.target,
      stats: vm.stats ?? { classes: 0, minutes: 0, corrections: 0, expressions: 0 },
      level: vm.level ?? null,
      weekUrl: `${base}/weeks/${x.target}.html`,
      indexUrl: `${base}/`,
      backfilledCount: x.backfilledCount ?? 0,
      degraded: [...(x.degraded ?? [])],
    };
  }
  if (outcome === OUTCOME.AUTH_EXPIRED) {
    return { authStaleSince: x.authStaleSince ?? null, indexUrl: `${base}/` };
  }
  const e = x.error || {};
  return {
    stage: x.stage ?? "fetch",
    errorName: e.name ?? "Error",
    errorMessage: e.message ?? String(e),
    attempts: e.attempts ?? null,
  };
}

// ── the run ──────────────────────────────────────────────────────────────────────

/**
 * Execute one generator run. Returns a summary; NEVER throws for an expected
 * outcome (auth-expired / fetch-failed are outcomes, not exceptions).
 *
 * @param {object} [opts] injectable seams for tests (fsImpl, fetchImpl, summarize,
 *   mailSend, nowMs, monotonic, dataDir, siteDir, backfill, force, trigger, fast).
 * @returns {Promise<{outcome:string, exitCode:number, weeksBuilt:string[],
 *   backfilledCount:number, lessonsFetched:number, emailOk:boolean,
 *   degraded:string[], target:string|null}>}
 */
export async function runGenerate(opts = {}) {
  const fsImpl = opts.fsImpl ?? fs;
  const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? "data";
  const siteDir = opts.siteDir ?? process.env.SITE_DIR ?? "dist";
  const nowMs = opts.nowMs ?? resolveNow();
  const backfill = opts.backfill === true;
  const force = opts.force === true;
  const trigger = opts.trigger ?? (backfill ? "backfill" : "cron");
  const log = opts.log ?? (() => {});
  const monotonic = opts.monotonic ?? (() => Date.now());
  const t0 = monotonic();

  const base = opts.base ?? camblyBase();
  const uid = opts.uid ?? camblyUid();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const summarize = opts.summarize ?? summarizeWeek;
  const mailSend = opts.mailSend ?? sendEmail;
  const fast = opts.fast ?? {}; // { sleep, backoff, retries } — zero-delay in tests
  const netOpts = { fetchImpl, ...fast };
  const mailOpts = { fetchImpl, ...fast, ...(opts.mailOpts ?? {}) };

  const model = opts.model ?? openaiModel();
  const openaiApiKey = opts.openaiApiKey ?? openaiKey();
  const openaiBaseUrl = opts.openaiBase ?? openaiBase();

  const firstWeek = resolveFirstWeekId(nowMs);

  // Accumulators shared across the run.
  const degraded = new Set();
  const weeksBuilt = [];
  let backfilledCount = 0;
  let lessonsFetched = 0;
  let rejectsTotal = 0;
  let tutorsPatched = 0;

  // Phase 1 — outcome selection (fetch → normalize → summarize → build).
  let result;
  try {
    const state = loadCamblyState(fsImpl, opts.statePath, log);
    const headers = authHeaders(state, { warn: log });
    const listOpts = { base, uid, headers, ...netOpts };

    const listingLessons = backfill
      ? await paginateListing({ firstWeekStartMs: weekIdToStartMs(firstWeek), now: nowMs, ...listOpts })
      : await fetchListing({ maxScheduledStartAt: nowMs, ...listOpts });

    const existingWeekIds = listExistingWeekIds(dataDir, fsImpl);
    // Raw-set fingerprint (§3 windower, U-MW⑦): the already-built short-circuit must
    // also see an UNCHANGED lesson set, else a lesson that landed after the week was
    // first built is never incorporated without --force. Compare the target week's
    // current listing ids against the lessonIds recorded in the existing VM.
    const targetId = targetWeekId(nowMs);
    const targetLessonIds = listingLessons
      .filter((l) => {
        const t = l?.scheduledStartAt?.$date;
        return typeof t === "number" && isInWeek(t, targetId);
      })
      .map((l) => l.id);
    const existingTargetVM = readWeekVM(dataDir, targetId, fsImpl);
    const builtLessonIds = existingTargetVM
      ? (existingTargetVM.classes || []).map((c) => c.lessonId)
      : undefined;
    const bs = computeBuildSet({
      firstWeekId: firstWeek,
      existingWeekIds,
      nowMs,
      force,
      targetLessonIds,
      builtLessonIds,
    });
    const target = bs.target;
    // Idempotence: an already-built target is not re-summarized (skipped from the work set).
    const weeksToProcess = bs.buildSet.filter((w) => !(w === target && bs.targetAlreadyBuilt));

    // Gather the listing records per week, and every tutor id, up front.
    const perWeek = new Map();
    const allRecords = [];
    for (const w of weeksToProcess) {
      const recs = listingLessons.filter((l) => {
        const t = l?.scheduledStartAt?.$date;
        return typeof t === "number" && isInWeek(t, w);
      });
      perWeek.set(w, recs);
      allRecords.push(...recs);
    }
    // Tutors: the persisted map (data/tutors.json) merged with this run's fetch, so a
    // tutor named once stays named even when the endpoint later answers empty.
    let tutorsMap = readTutorsMap(dataDir, fsImpl);
    if (allRecords.length) {
      const ids = [...new Set(allRecords.map(lessonTutorId).filter(Boolean))];
      const fetched = await fetchTutors(ids, { base, headers, ...netOpts });
      if (Object.keys(fetched).length) tutorsMap = persistTutorsMap(dataDir, fetched, fsImpl);
    }

    // Build each week: fetch+normalize its lessons, summarize+gate, write the VM.
    for (const w of weeksToProcess) {
      const win = weekWindow(weekIdToStartMs(w));
      const recs = perWeek.get(w) || [];
      const normalized = [];
      for (const rec of recs) {
        const { lesson, fetched, degraded: lessonDegraded } = await ensureRawAndNormalize(rec, {
          dataDir,
          base,
          uid,
          headers,
          tutorsMap,
          fsImpl,
          netOpts,
          degraded,
        });
        // §7: a dead corrections endpoint is fetch-failed, NOT a silently zeroed Σ set.
        // The builder cannot distinguish "genuinely 0 corrections" from "endpoint dead"
        // (the __status stub normalizes to []), so gate on the degraded signal here and
        // refuse to publish — the raw stub forces a re-fetch on the next run (self-heal).
        if (lessonDegraded.includes(CORRECTIONS_ENDPOINT)) {
          throw Object.assign(
            new Error(
              `${CORRECTIONS_ENDPOINT} endpoint dead for lesson ${rec.id} in week ${w} — ` +
                `refusing to publish a week with silently-zeroed corrections (TECH §7)`,
            ),
            { stage: "fetch" },
          );
        }
        if (fetched) lessonsFetched += 1;
        normalized.push(lesson);
      }
      const gen = await generateWeekVM({
        window: win,
        lessons: normalized,
        model,
        now: nowMs,
        summarize,
        base: openaiBaseUrl,
        apiKey: openaiApiKey,
        fetchImpl,
        ...fast,
      });
      writeWeekVM(dataDir, w, gen.weekVM, fsImpl);
      weeksBuilt.push(w);
      rejectsTotal += gen.weekVM.integrity?.rejectedCount ?? 0;
      if (w !== target && gen.weekVM.isEmpty !== true) backfilledCount += 1;
    }

    // Tutor self-heal: name every published class whose tutor was lost (spec A2).
    tutorsPatched = patchTutorNames({ dataDir, fsImpl, tutorsMap, log });

    const targetVM = readWeekVM(dataDir, target, fsImpl);
    const targetEmpty = !targetVM || targetVM.isEmpty === true;
    result = {
      outcome: targetEmpty ? OUTCOME.NO_CLASSES : OUTCOME.PUBLISHED,
      exitCode: 0,
      target,
      targetVM,
    };
  } catch (err) {
    if (err instanceof AuthExpiredError || err?.authExpired) {
      result = { outcome: OUTCOME.AUTH_EXPIRED, exitCode: 3, error: err };
    } else {
      result = { outcome: OUTCOME.FETCH_FAILED, exitCode: 2, error: err, stage: err?.stage ?? "fetch" };
    }
  }

  // Phase 2 — side effects: site-state, render, mail, healthz (LAST). The prior
  // state is read ONCE, before any write, so fetch-failed can preserve authStale.
  const prior = readSiteState(dataDir, { fsImpl });
  let emailOk = true;
  let facts = null;

  if (result.outcome === OUTCOME.PUBLISHED || result.outcome === OUTCOME.NO_CLASSES) {
    const builtSomething = weeksBuilt.length > 0;
    // Clear authStale BEFORE the render so the banner is removed on a recovered run.
    writeSiteState(
      dataDir,
      makeSiteState({ outcome: result.outcome, nowMs, authStale: false, authStaleSince: null, emailOk: true }),
      fsImpl,
    );
    try {
      facts = buildSite({ dataDir, siteDir, nowMs, fsImpl }).facts;
    } catch (err) {
      // A render abort fails closed (served site untouched) → treat as fetch-failed.
      result = { outcome: OUTCOME.FETCH_FAILED, exitCode: 2, error: err, stage: "build" };
    }

    if (result.outcome !== OUTCOME.FETCH_FAILED) {
      if (builtSomething) {
        const ctx = mailCtx(result.outcome, {
          target: result.target,
          targetVM: result.targetVM,
          backfilledCount,
          degraded,
        });
        const send = await mailSend(result.outcome, ctx, mailOpts);
        emailOk = send.ok;
      }
      const finalState = makeSiteState({
        outcome: result.outcome,
        nowMs,
        authStale: false,
        authStaleSince: null,
        emailOk,
      });
      writeSiteState(dataDir, finalState, fsImpl);
      facts = facts ?? computeFacts(readWeeks(dataDir, { fsImpl }));
      fsImpl.mkdirSync(siteDir, { recursive: true });
      writeHealthz(siteDir, { siteState: finalState, facts, nowMs }, { fsImpl }); // healthz LAST
    }
  }

  if (result.outcome === OUTCOME.AUTH_EXPIRED) {
    const authStaleSince =
      prior.authStale === true && prior.authStaleSince ? prior.authStaleSince : cstDateString(nowMs);
    writeSiteState(
      dataDir,
      makeSiteState({ outcome: OUTCOME.AUTH_EXPIRED, nowMs, authStale: true, authStaleSince, emailOk: true }),
      fsImpl,
    );
    // Best-effort re-render so the amber banner lands on EVERY page.
    try {
      facts = buildSite({ dataDir, siteDir, nowMs, fsImpl }).facts;
    } catch (err) {
      log(`auth-expired banner re-render skipped: ${err.message}`);
    }
    const send = await mailSend(OUTCOME.AUTH_EXPIRED, mailCtx(OUTCOME.AUTH_EXPIRED, { authStaleSince }), mailOpts);
    emailOk = send.ok;
    const finalState = makeSiteState({
      outcome: OUTCOME.AUTH_EXPIRED,
      nowMs,
      authStale: true,
      authStaleSince,
      emailOk,
    });
    writeSiteState(dataDir, finalState, fsImpl);
    facts = facts ?? computeFacts(readWeeks(dataDir, { fsImpl }));
    fsImpl.mkdirSync(siteDir, { recursive: true });
    writeHealthz(siteDir, { siteState: finalState, facts, nowMs }, { fsImpl }); // healthz LAST
  }

  if (result.outcome === OUTCOME.FETCH_FAILED) {
    // Site unchanged: preserve the prior banner state, do NOT re-render.
    const authStale = prior.authStale === true;
    const authStaleSince = authStale ? prior.authStaleSince ?? cstDateString(nowMs) : null;
    const send = await mailSend(
      OUTCOME.FETCH_FAILED,
      mailCtx(OUTCOME.FETCH_FAILED, { stage: result.stage, error: result.error }),
      mailOpts,
    );
    emailOk = send.ok;
    const finalState = makeSiteState({
      outcome: OUTCOME.FETCH_FAILED,
      nowMs,
      authStale,
      authStaleSince,
      emailOk,
    });
    writeSiteState(dataDir, finalState, fsImpl);
    facts = computeFacts(readWeeks(dataDir, { fsImpl }));
    fsImpl.mkdirSync(siteDir, { recursive: true });
    writeHealthz(siteDir, { siteState: finalState, facts, nowMs }, { fsImpl }); // healthz LAST
  }

  appendRunLog(
    dataDir,
    runLogEntry({
      nowMs,
      trigger,
      result,
      weeksBuilt,
      lessonsFetched,
      rejects: rejectsTotal,
      backfilled: backfilledCount,
      emailOk,
      tutorsPatched,
      durationMs: monotonic() - t0,
    }),
    fsImpl,
  );

  return {
    outcome: result.outcome,
    exitCode: result.exitCode,
    weeksBuilt,
    backfilledCount,
    lessonsFetched,
    emailOk,
    degraded: [...degraded],
    target: result.target ?? null,
  };
}

// ── offline modes: --rebuild / --render ──────────────────────────────────────────

/** The seams shared by the offline modes (fsImpl, dataDir, siteDir, nowMs, log, monotonic). */
function offlineEnv(opts) {
  const monotonic = opts.monotonic ?? (() => Date.now());
  return {
    fsImpl: opts.fsImpl ?? fs,
    dataDir: opts.dataDir ?? process.env.DATA_DIR ?? "data",
    siteDir: opts.siteDir ?? process.env.SITE_DIR ?? "dist",
    nowMs: opts.nowMs ?? resolveNow(),
    log: opts.log ?? (() => {}),
    monotonic,
    t0: monotonic(),
  };
}

const rebuildError = (msg) => Object.assign(new Error(msg), { stage: "rebuild" });

/**
 * True iff a YYYY-MM-DD string names a REAL calendar date. Date.UTC silently rolls an
 * out-of-range month/day forward (2026-13-99 → 2027-04-09), so the parsed parts must
 * round-trip exactly.
 */
function isCalendarDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * Validate + canonicalize --rebuild week ids: a real calendar date (YYYY-MM-DD), snapped to
 * its CST Monday, de-duplicated — and never a week that has not ended yet (anything after the
 * latest complete week as of nowMs), which could only ever mint a bogus "no classes" stub.
 */
function canonicalWeekIds(weekIds, { nowMs, log }) {
  if (!Array.isArray(weekIds) || weekIds.length === 0) throw rebuildError("--rebuild needs at least one weekId (YYYY-MM-DD)");
  const target = targetWeekId(nowMs);
  const canon = weekIds.map((id) => {
    const s = typeof id === "string" ? id.trim() : "";
    if (!WEEK_ID_RE.test(s) || !isCalendarDate(s)) {
      throw rebuildError(`invalid weekId ${JSON.stringify(id)} (expected a real calendar date, YYYY-MM-DD)`);
    }
    const monday = weekWindow(weekIdToStartMs(s)).weekId;
    if (monday !== s) log(`weekId ${s} is not a Monday — rebuilding its week ${monday}`);
    if (monday > target) {
      throw rebuildError(`week ${monday} has not ended yet (the latest complete week is ${target}) — refusing to rebuild it`);
    }
    return monday;
  });
  return [...new Set(canon)].sort();
}

/** Rebuild ONE week's VM from its complete raw dirs (offline). Returns the generated VM. */
async function rebuildWeek(w, ctx) {
  const { dataDir, fsImpl, uid, tutorsMap, rawLessons, gen, log } = ctx;
  const lessons = rawLessons
    .filter((r) => r.weekId === w)
    .sort((a, b) => a.startMs - b.startMs || a.lessonId.localeCompare(b.lessonId))
    .map((r) => normalizeLessonDir(r.dir, { fsImpl, uid, tutors: tutorsMap }));
  const existing = readWeekVM(dataDir, w, fsImpl);
  if (lessons.length === 0 && existing && existing.isEmpty !== true) {
    throw rebuildError(
      `no complete raw lessons for week ${w} but its VM has ${(existing.classes || []).length} class(es) — refusing to overwrite it with an empty stub`,
    );
  }
  if (lessons.length === 0 && !existing) {
    // A week the recap has never seen: inside the cron's own range it becomes the same
    // "no classes" stub the self-heal would write; before FIRST_WEEK it can only be a typo.
    const floor = firstWeekFloor();
    if (floor && w < floor) {
      throw rebuildError(`week ${w} has no raw lessons, no VM, and lies before FIRST_WEEK ${floor} — refusing to create an empty stub`);
    }
    log(`rebuild ${w}: no raw lessons and no prior VM — writing an empty "no classes" stub (check the weekId if this is unexpected)`);
  }
  log(`rebuild ${w}: ${lessons.length} lesson(s) from data/raw`);
  const out = await gen({ window: weekWindow(weekIdToStartMs(w)), lessons });
  return out.weekVM; // staged by runRebuild — nothing is written until EVERY week succeeded
}

/**
 * --rebuild=<weekId>[,…] (spec A4). OFFLINE — no Cambly call: each week's lessons are the
 * complete data/raw dirs dated inside it, normalized with the persisted tutors map,
 * re-summarized (LLM via the injectable `summarize`), written; then tutors self-heal and
 * the site is rebuilt (healthz inside the render). No email unless `mail:true` (--mail);
 * site-state.json untouched; runs.ndjson trigger:"rebuild". Exit 0, or 2 on any failure.
 * @param {object} opts weekIds (string[]), mail, plus the runGenerate seams (fsImpl, summarize,
 *   mailSend, nowMs, monotonic, dataDir, siteDir, log, uid, model, openaiApiKey, openaiBase, fetchImpl, fast).
 * @returns {Promise<{outcome:string, exitCode:number, weeksBuilt:string[], emailOk:boolean, tutorsPatched:number, rejects:number}>}
 */
export async function runRebuild(opts = {}) {
  const env = offlineEnv(opts);
  const { fsImpl, dataDir, siteDir, nowMs, log } = env;
  const summarize = opts.summarize ?? summarizeWeek;
  const mailSend = opts.mailSend ?? sendEmail;
  const fast = opts.fast ?? {};
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const mailOpts = { fetchImpl, ...fast, ...(opts.mailOpts ?? {}) };

  const weeksBuilt = [];
  const built = new Map();
  let rejects = 0;
  let tutorsPatched = 0;
  let stage = "rebuild"; // → "summarize" once lessons are being re-summarized → "build" for the render
  let result;
  try {
    const weekIds = canonicalWeekIds(opts.weekIds, { nowMs, log });
    const uid = opts.uid ?? camblyUid();
    const tutorsMap = readTutorsMap(dataDir, fsImpl);
    const rawLessons = listCompleteRawLessons(dataDir, { fsImpl });
    const llm = { model: opts.model ?? openaiModel(), base: opts.openaiBase ?? openaiBase(), apiKey: opts.openaiApiKey ?? openaiKey() };
    const gen = ({ window, lessons }) =>
      generateWeekVM({ window, lessons, now: nowMs, summarize, fetchImpl, ...llm, ...fast });
    stage = "summarize";
    for (const w of weekIds) {
      built.set(w, await rebuildWeek(w, { dataDir, fsImpl, uid, tutorsMap, rawLessons, gen, log }));
    }
    stage = "build"; // all-or-nothing (Codex, PR #4): staged VMs are written only once EVERY week succeeded
    for (const [w, vm] of built) {
      writeWeekVM(dataDir, w, vm, fsImpl);
      weeksBuilt.push(w);
      rejects += vm.integrity?.rejectedCount ?? 0;
    }
    tutorsPatched = patchTutorNames({ dataDir, fsImpl, tutorsMap, log });
    buildSite({ dataDir, siteDir, nowMs, fsImpl }); // validates, swaps, writes healthz LAST
    const allEmpty = [...built.values()].every((vm) => vm.isEmpty === true);
    result = { outcome: allEmpty ? OUTCOME.NO_CLASSES : OUTCOME.PUBLISHED, exitCode: 0 };
  } catch (err) {
    result = { outcome: OUTCOME.FETCH_FAILED, exitCode: 2, error: err, stage: err?.stage ?? stage };
    log(`rebuild failed at ${result.stage}: ${err?.message}`);
  }

  let emailOk = true;
  if (result.exitCode === 0 && opts.mail === true) {
    for (const w of weeksBuilt) {
      const vm = built.get(w);
      const outcome = vm.isEmpty === true ? OUTCOME.NO_CLASSES : OUTCOME.PUBLISHED;
      const send = await mailSend(outcome, mailCtx(outcome, { target: w, targetVM: vm }), mailOpts);
      emailOk = emailOk && send.ok;
    }
  }

  appendRunLog(
    dataDir,
    runLogEntry({ nowMs, trigger: "rebuild", result, weeksBuilt, rejects, emailOk, tutorsPatched, durationMs: env.monotonic() - env.t0 }),
    fsImpl,
  );
  return { outcome: result.outcome, exitCode: result.exitCode, weeksBuilt, emailOk, tutorsPatched, rejects };
}

/**
 * --render (spec A4). OFFLINE and LLM-free: self-heal tutor names from the persisted map,
 * then rebuild the whole site from data/ (healthz written LAST by the renderer).
 * site-state.json untouched; runs.ndjson trigger:"render". Exit 0, or 2 when the render aborts.
 * @param {object} opts the seams: fsImpl, nowMs, monotonic, dataDir, siteDir, log.
 * @returns {Promise<{outcome:string, exitCode:number, weeksBuilt:string[], emailOk:boolean, tutorsPatched:number, weekPages:string[]}>}
 */
export async function runRender(opts = {}) {
  const env = offlineEnv(opts);
  const { fsImpl, dataDir, siteDir, nowMs, log } = env;
  let tutorsPatched = 0;
  let weekPages = [];
  let result;
  try {
    tutorsPatched = patchTutorNames({ dataDir, fsImpl, tutorsMap: readTutorsMap(dataDir, fsImpl), log });
    weekPages = buildSite({ dataDir, siteDir, nowMs, fsImpl }).weekPages;
    result = { outcome: OUTCOME.PUBLISHED, exitCode: 0 };
  } catch (err) {
    result = { outcome: OUTCOME.FETCH_FAILED, exitCode: 2, error: err, stage: "build" };
    log(`render failed: ${err?.message}`);
  }
  appendRunLog(
    dataDir,
    runLogEntry({ nowMs, trigger: "render", result, weeksBuilt: [], emailOk: true, tutorsPatched, durationMs: env.monotonic() - env.t0 }),
    fsImpl,
  );
  return { outcome: result.outcome, exitCode: result.exitCode, weeksBuilt: [], emailOk: true, tutorsPatched, weekPages };
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────────

const BOOLEAN_FLAGS = ["--backfill", "--force", "--manual", "--render", "--mail"];
const REBUILD_PREFIX = "--rebuild=";
export const USAGE =
  "usage: node src/run.js [--backfill] [--force] [--manual]  |  --rebuild=<weekId>[,<weekId>…] [--mail]  |  --render";

/** A malformed command line. Raised BEFORE any side effect; main() prints it and exits 2. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.exitCode = 2;
  }
}

/**
 * CLI flags → options. `--rebuild=<weekId>[,<weekId>…]` selects the offline rebuild
 * (`rebuild` = the id list, else null; several --rebuild= flags concatenate); `--render`
 * the offline re-render; `--mail` lets a rebuild send its 📗/📭 email. --backfill /
 * --force / --manual drive runGenerate. STRICT: every token must be one of these exact
 * forms — a near-miss (`--rebuild 2026-08-24`, a bare `--rebuild`, `--render=…`) or any
 * unknown token throws UsageError instead of silently falling through to the ONLINE cron
 * path (Cambly fetch, site-state.json rewrite, email), which the offline modes promise never
 * to touch.
 */
export function parseArgs(argv) {
  const tokens = argv.map(String);
  const stray = tokens.find((a) => !BOOLEAN_FLAGS.includes(a) && !a.startsWith(REBUILD_PREFIX));
  if (stray !== undefined) throw new UsageError(`unrecognised argument ${JSON.stringify(stray)}\n${USAGE}`);
  const rebuildLists = tokens.filter((a) => a.startsWith(REBUILD_PREFIX));
  const rebuild =
    rebuildLists.length === 0
      ? null
      : rebuildLists.flatMap((a) => a.slice(REBUILD_PREFIX.length).split(",").map((s) => s.trim()).filter(Boolean));
  const flags = Object.fromEntries(BOOLEAN_FLAGS.map((f) => [f.slice(2), tokens.includes(f)]));
  assertFlagCombination(flags, rebuild);
  return { ...flags, rebuild };
}

const ONLINE_ONLY = ["backfill", "force", "manual"]; // runGenerate-only flags
/**
 * Exactly ONE mode per invocation — online (--backfill/--force/--manual or nothing),
 * --rebuild=…, or --render — and `--mail` is rebuild-only. A token-only check let a stray
 * `--mail` (or `--render --backfill`) fall through to the ONLINE cron path (Codex, PR #4).
 */
function assertFlagCombination(flags, rebuild) {
  const conflict = (msg) => { throw new UsageError(`flags cannot be combined: ${msg}\n${USAGE}`); };
  const online = ONLINE_ONLY.filter((f) => flags[f]).map((f) => `--${f}`);
  if (flags.render && rebuild !== null) conflict("--render with --rebuild=");
  if (flags.render && online.length) conflict(`--render with ${online.join(" ")}`);
  if (rebuild !== null && online.length) conflict(`--rebuild= with ${online.join(" ")}`);
  if (flags.mail && rebuild === null) conflict(flags.render ? "--render with --mail (mail is rebuild-only)" : "--mail without --rebuild= (mail is rebuild-only)");
}

async function main() {
  const log = (m) => process.stderr.write(`[cambly-recap] ${m}\n`);
  let a;
  try {
    a = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    log(err.message);
    process.exit(err.exitCode); // nothing has been read, fetched, written or mailed yet
  }
  const trigger = a.backfill ? "backfill" : a.manual ? "manual" : "cron";
  const res = a.rebuild
    ? await runRebuild({ weekIds: a.rebuild, mail: a.mail, log })
    : a.render
      ? await runRender({ log })
      : await runGenerate({ backfill: a.backfill, force: a.force, trigger, log });
  log(
    `outcome=${res.outcome} weeks=${res.weeksBuilt.join(",") || "-"} ` +
      `backfilled=${res.backfilledCount ?? 0} email=${res.emailOk} exit=${res.exitCode}`,
  );
  process.exit(res.exitCode);
}

function isMain(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(metaUrl) === fs.realpathSync(entry) || metaUrl === pathToFileURL(entry).href;
  } catch {
    return metaUrl === pathToFileURL(entry).href;
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[cambly-recap] fatal: ${err?.stack || err}\n`);
    process.exit(2);
  });
}
