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
import { normalizeLessonDir } from "./normalize.js";
import { generateWeekVM } from "./build.js";
import { openaiBase, openaiKey, openaiModel, summarizeWeek } from "./summarize.js";
import { buildSite, readWeeks, readSiteState, computeFacts } from "./render/site.js";
import { writeHealthz } from "./render/healthz.js";
import { OUTCOME, RECOVERY_COMMANDS, sendEmail, siteUrl } from "./mail.js";

const SCHEMA_VERSION = 1;
const STATE_PATH_DEFAULT = "/secrets/cambly-state.json";

/** Raw endpoint → on-disk filename (mirrors normalize.js so normalizeLessonDir reads them). */
const RAW_FILES = {
  lesson_transcript: "lesson_transcript.json",
  talon_chats: "talon_chats.json",
  corrective_feedback_corrections: "corrective_feedback_corrections.json",
  positive_feedbacks: "positive_feedbacks.json",
  ai_tutor_student_feedbacks: "ai_tutor_student_feedbacks.json",
  tutor_student_feedbacks: "tutor_student_feedbacks.json",
  user_lesson_stats: "user_lesson_stats.json",
  lesson_parts: "lesson_parts.json",
  lesson_plan: "lesson_plan.json",
};

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

function listExistingWeekIds(dataDir, fsImpl) {
  try {
    return fsImpl
      .readdirSync(path.join(dataDir, "weeks"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

function readWeekVM(dataDir, weekId, fsImpl) {
  try {
    return JSON.parse(fsImpl.readFileSync(path.join(dataDir, "weeks", `${weekId}.json`), "utf8"));
  } catch {
    return null;
  }
}

function writeWeekVM(dataDir, weekId, vm, fsImpl) {
  const dir = path.join(dataDir, "weeks");
  fsImpl.mkdirSync(dir, { recursive: true });
  fsImpl.writeFileSync(path.join(dir, `${weekId}.json`), JSON.stringify(vm, null, 2) + "\n");
}

function writeRaw(dir, files, rec, tutorsArr, fsImpl) {
  fsImpl.mkdirSync(dir, { recursive: true });
  fsImpl.writeFileSync(path.join(dir, "_lesson.json"), JSON.stringify(rec, null, 2));
  fsImpl.writeFileSync(path.join(dir, "tutors.json"), JSON.stringify({ result: tutorsArr }, null, 2));
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

// ── network helpers ──────────────────────────────────────────────────────────────

function tutorIdOf(rec) {
  return rec.tutorId || (Array.isArray(rec.tutorIds) ? rec.tutorIds[0] : null);
}

async function fetchTutors(ids, ctx) {
  if (!ids.length) return [];
  const { base, headers, fetchImpl, sleep, backoff, retries } = ctx;
  const r = await fetchEndpoint(tutorsUrl(base, ids), {
    label: "tutors",
    fatal: false,
    headers,
    fetchImpl,
    sleep,
    backoff,
    retries,
  });
  return Array.isArray(r.json?.result) ? r.json.result : [];
}

/**
 * Ensure a lesson's raw dir exists (fetch-level idempotence: a complete dir is never
 * re-fetched) and return the normalized lesson. Auth expiry on any endpoint throws
 * AuthExpiredError up to the run's outcome selector.
 */
async function ensureRawAndNormalize(rec, ctx) {
  const { dataDir, base, uid, headers, tutorsArr, fsImpl, netOpts, degraded } = ctx;
  const lid = rec.id;
  const dir = path.join(dataDir, "raw", lid);
  let fetched = false;
  let lessonDegraded = [];
  if (!isLessonRawComplete(dir, { fsImpl })) {
    const res = await fetchLesson(lid, { base, uid, lesson: rec, headers, ...netOpts });
    lessonDegraded = res.degraded;
    for (const d of res.degraded) degraded.add(d);
    writeRaw(dir, res.files, rec, tutorsArr, fsImpl);
    fetched = true;
  }
  const lesson = normalizeLessonDir(dir, { fsImpl, uid, lesson: rec, tutors: tutorsArr });
  return { lesson, fetched, degraded: lessonDegraded };
}

/** The corrections endpoint is the Σ anchor: a dead one can't be told from "0 corrections". */
const CORRECTIONS_ENDPOINT = "corrective_feedback_corrections";

/** FIRST_WEEK bounds the missed-week self-heal; default = target-only when unset. */
function resolveFirstWeekId(nowMs) {
  const raw = process.env.FIRST_WEEK;
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return raw.trim();
  return targetWeekId(nowMs);
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
    let tutorsArr = [];
    if (allRecords.length) {
      const ids = [...new Set(allRecords.map(tutorIdOf).filter(Boolean))];
      tutorsArr = await fetchTutors(ids, { base, headers, ...netOpts });
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
          tutorsArr,
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
    {
      at: cstIso(nowMs),
      trigger,
      outcome: result.outcome,
      weeksBuilt,
      lessonsFetched,
      rejects: rejectsTotal,
      backfilled: backfilledCount,
      emailOk,
      durationMs: Math.max(0, monotonic() - t0),
      error: result.error ? `${result.error.name}: ${result.error.message}` : null,
    },
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

// ── CLI entrypoint ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  return {
    backfill: argv.includes("--backfill"),
    force: argv.includes("--force"),
    manual: argv.includes("--manual"),
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const trigger = a.backfill ? "backfill" : a.manual ? "manual" : "cron";
  const log = (m) => process.stderr.write(`[cambly-recap] ${m}\n`);
  const res = await runGenerate({ backfill: a.backfill, force: a.force, trigger, log });
  log(
    `outcome=${res.outcome} weeks=${res.weeksBuilt.join(",") || "-"} ` +
      `backfilled=${res.backfilledCount} email=${res.emailOk} exit=${res.exitCode}`,
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
