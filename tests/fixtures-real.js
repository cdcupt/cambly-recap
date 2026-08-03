// tests/fixtures-real.js — helpers for the recorded real-archive fixtures.
//
// Real transcripts/corrections live OUTSIDE the repo (PRD S6) under FIXTURES_DIR
// (default ~/cambly-lesson-archive/data). These helpers locate them and let each
// suite skip gracefully with a clear message when they are absent, so the suite
// still smoke-runs from a bare clone.
//
// NOT a test file (no test() calls; name does not match the runner's glob).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The student UID the fixtures' transcript lines were actually recorded against.
//
// normalize.js labels each turn student|tutor by comparing its userId to this
// value, so a UID that matches nothing silently labels EVERY line "tutor" — the
// recent-fixture tests then find zero student lines and fail an assertion that
// reads like a fixture problem. That is exactly what the sanitisation placeholder
// below did once the personal id was parameterised out into $CAMBLY_UID (which is
// what src/fetch.js and src/normalize.js already use).
//
// So: take the real value from the environment like the rest of the repo does,
// and keep the placeholder only as the "no UID configured" sentinel that
// recentFixturesSkip() checks for.
export const PLACEHOLDER_STUDENT_UID = "0123456789abcdef01234567";
export const REAL_STUDENT_UID = process.env.CAMBLY_UID || PLACEHOLDER_STUDENT_UID;

/** The 11 archived lesson dirs → their expected CST weekId (from TECH U-WK ⑧). */
export const EXPECTED_WEEK = {
  "2026-05-07_69f30a9d": "2026-05-04",
  "2026-05-09_69fc9e24": "2026-05-04",
  "2026-05-13_6a00a5d1": "2026-05-11",
  "2026-05-15_6a00a5ed": "2026-05-11",
  "2026-05-20_6a08cce2": "2026-05-18",
  "2026-05-24_6a08cc78": "2026-05-18",
  "2026-05-28_6a1185fd": "2026-05-25",
  "2026-05-30_6a1188bc": "2026-05-25",
  "2026-05-31_6a1188c5": "2026-05-25",
  "2026-06-06_6a1188bc": "2026-06-01",
  "2026-06-07_6a1188c5": "2026-06-01",
};

/** The 5 distinct weekIds the 11 archived lessons fall into. */
export const EXPECTED_WEEK_IDS = [
  "2026-05-04",
  "2026-05-11",
  "2026-05-18",
  "2026-05-25",
  "2026-06-01",
];

export function fixturesDir() {
  return process.env.FIXTURES_DIR || path.join(os.homedir(), "cambly-lesson-archive", "data");
}

/**
 * The RECENT-shape fixtures (0 corrective corrections, rich ai_tutor feedback,
 * scheduledMinutes on the listing record). Each subdir carries a real _lesson.json
 * listing entry alongside the per-endpoint files. Overridable via RECENT_FIXTURES_DIR.
 */
export function recentFixturesDir() {
  return process.env.RECENT_FIXTURES_DIR || path.join(fixturesDir(), "_recent_fixtures");
}

/** Reason string when the recent fixtures are unavailable, else false. */
export function recentFixturesSkip() {
  const dir = recentFixturesDir();
  if (!fs.existsSync(dir)) {
    return `recent fixtures absent (${dir} not found) — run with RECENT_FIXTURES_DIR set`;
  }
  // The dir existing is NOT enough. These suites assert on student transcript
  // lines, and speaker labelling is resolved against $CAMBLY_UID — so without it
  // they cannot pass, no matter what is on disk. Skip with a reason instead of
  // failing an assertion that misleadingly blames the fixtures.
  if (REAL_STUDENT_UID === PLACEHOLDER_STUDENT_UID) {
    return "CAMBLY_UID not set — speaker labelling would mark every line 'tutor'";
  }
  return false;
}

/** Absolute paths to each recent lesson dir that carries an _lesson.json listing record. */
export function presentRecentLessonDirs() {
  const dir = recentFixturesDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((d) => path.join(dir, d))
    .filter(
      (p) => fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, "_lesson.json")),
    );
}

/** Reason string when the archive is unavailable, else false (so tests can pass `skip`). */
export function realFixturesSkip() {
  const dir = fixturesDir();
  if (!fs.existsSync(dir)) {
    return `real fixtures absent (FIXTURES_DIR=${dir} not found) — run with FIXTURES_DIR set`;
  }
  return false;
}

/** Lesson dirs present in the archive that we have an expected weekId for. */
export function presentLessonDirs() {
  const dir = fixturesDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => EXPECTED_WEEK[d] && fs.existsSync(path.join(dir, d, "lesson_transcript.json")));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * A representative real lesson-start epoch for a dir. The archive carries no
 * _lesson.json listing record (TECH Unresolved #2), so we recover the start from the
 * richest available real timestamp: video archive start → AI feedback createdAt →
 * first talon-chat timestamp.
 */
export function realEpochOf(dir) {
  const base = path.join(fixturesDir(), dir);
  const vs = readJson(path.join(base, "video_sessions.json"));
  const vEpoch = vs?.result?.agoraData?.archive?.startedAt?.$date;
  if (typeof vEpoch === "number") return vEpoch;
  const ai = readJson(path.join(base, "ai_tutor_student_feedbacks.json"));
  const aiEpoch = ai?.result?.[0]?.createdAt?.$date;
  if (typeof aiEpoch === "number") return aiEpoch;
  const tc = readJson(path.join(base, "talon_chats.json"));
  const tcEpoch = tc?.result?.[0]?.timestamp?.$date;
  if (typeof tcEpoch === "number") return tcEpoch;
  return null;
}

/** Map of dir → { lid, topic, minutes } from the archive's derived index.json, if present. */
export function archiveIndexByDir() {
  const idx = readJson(path.join(fixturesDir(), "..", "index.json"));
  const map = {};
  if (Array.isArray(idx)) {
    for (const row of idx) if (row && row.stub) map[row.stub] = row;
  }
  return map;
}
